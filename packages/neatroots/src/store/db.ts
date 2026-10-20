import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BlobStore } from "./blobs.js";
import { SearchIds } from "./search-ids.js";
import { sha256, newId } from "../util/ids.js";
import { buildView, preview, type SpanView } from "../semantics/view.js";
import { hasRemoteParent, kvToPlain, type KeyValue, type OtlpResource, type OtlpScope, type OtlpSpan, type Plain, type ResourceSpansBatch } from "../otlp/types.js";
import type {
  Annotation,
  DecisionRow,
  Explanation,
  Finding,
  FindingStatus,
  ForwardRow,
  Note,
  NoteStatus,
  PlanRow,
  RunRow,
  SpanRow,
} from "../types.js";
import type { OtlpLogRecord } from "../otlp/codec.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT,
  workflow TEXT,
  first_seen_ms INTEGER,
  last_seen_ms INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  workflow TEXT,
  root_span_id TEXT,
  root_name TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  complete INTEGER NOT NULL DEFAULT 0,
  root_ended INTEGER NOT NULL DEFAULT 0,
  started_ms INTEGER,
  ended_ms INTEGER,
  last_span_ms INTEGER,
  span_count INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  input_preview TEXT,
  output_preview TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  termination_reason TEXT,
  finding_count INTEGER NOT NULL DEFAULT 0,
  open_finding_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  doctor INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  received_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_ms DESC);
-- The run list and Insights sort and filter by this expression; an index on started_ms alone can't serve them.
CREATE INDEX IF NOT EXISTS runs_sort ON runs (COALESCE(started_ms, received_ms) DESC);
CREATE INDEX IF NOT EXISTS runs_session ON runs (session_id);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs (workflow);
CREATE INDEX IF NOT EXISTS runs_project ON runs (project);

CREATE TABLE IF NOT EXISTS spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  span_kind TEXT NOT NULL,
  otel_kind INTEGER NOT NULL DEFAULT 0,
  start_ns TEXT NOT NULL,
  end_ns TEXT NOT NULL,
  start_ms REAL NOT NULL,
  end_ms REAL NOT NULL,
  duration_ms REAL NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,
  status_message TEXT,
  model TEXT,
  provider TEXT,
  tool_name TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  input_preview TEXT,
  output_preview TEXT,
  error TEXT,
  attributes TEXT NOT NULL,
  events TEXT NOT NULL,
  links TEXT NOT NULL,
  extra TEXT,
  blobs TEXT,
  is_marker INTEGER NOT NULL DEFAULT 0,
  resource_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS spans_trace_start ON spans (trace_id, start_ms);
CREATE INDEX IF NOT EXISTS spans_seq ON spans (seq);
-- Covers the kind:, tool: and model: run filters, so they scan this instead of the wide span rows.
CREATE INDEX IF NOT EXISTS spans_filter ON spans (span_kind, tool_name, model, is_marker, trace_id, span_id);

CREATE VIRTUAL TABLE IF NOT EXISTS span_fts USING fts5 (
  trace_id UNINDEXED, span_id UNINDEXED, name, tool_name, body, tokenize = 'porter unicode61'
);
-- The run and span of each span_fts row, by rowid, so span_fts rows are found by run or span
-- without reading their text (see search-ids.ts).
CREATE TABLE IF NOT EXISTS span_fts_ids (id INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS span_fts_ids_span ON span_fts_ids (trace_id, span_id);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT,
  span_id TEXT,
  time_ns TEXT,
  severity TEXT,
  body TEXT,
  attributes TEXT,
  resource_id TEXT,
  received_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_trace ON logs (trace_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  model TEXT,
  rationale TEXT,
  check_ids TEXT NOT NULL,
  body TEXT
);
CREATE INDEX IF NOT EXISTS plans_workflow ON plans (workflow, created_ms DESC);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  span_id TEXT,
  probability REAL NOT NULL,
  answer TEXT,
  backend TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_trace ON decisions (trace_id, check_id);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  probability REAL,
  status TEXT NOT NULL,
  evidence_span_ids TEXT NOT NULL,
  detail TEXT NOT NULL,
  model TEXT,
  triage_score INTEGER,
  explanation_id TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_trace ON findings (trace_id);
CREATE INDEX IF NOT EXISTS findings_check ON findings (check_id);

CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  fix TEXT,
  evidence_span_ids TEXT NOT NULL,
  grounding REAL,
  model TEXT,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS explanations_target ON explanations (target_type, target_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  finding_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  delivered_ms INTEGER,
  delivered_span_id TEXT,
  replaced_by TEXT,
  checks TEXT
);
CREATE INDEX IF NOT EXISTS notes_trace ON notes (trace_id, status);

CREATE TABLE IF NOT EXISTS summaries (
  trace_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  model TEXT,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  label TEXT NOT NULL,
  text TEXT,
  author TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_trace ON annotations (trace_id);

CREATE TABLE IF NOT EXISTS forwards (
  id TEXT PRIMARY KEY,
  trace_ids TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  span_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  redactions INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  initiated_by TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  sha256 TEXT,
  mime_type TEXT,
  byte_length INTEGER,
  purpose TEXT,
  state TEXT NOT NULL,
  blob_sha TEXT,
  created_ms INTEGER NOT NULL
);
`;

export interface IngestedSpan {
  row: SpanRow;
  view: SpanView;
  isNew: boolean;
}

export interface TraceUpdate {
  traceId: string;
  spans: IngestedSpan[];
  runCreated: boolean;
  rootEnded: boolean;
  /** A parentless span took the root back from one that only qualified through its remote parent (#157). */
  rootHandedBack: boolean;
  completed: boolean;
}

export interface RunFilter {
  project?: string;
  workflow?: string;
  status?: string;
  sessionId?: string;
  hasFinding?: boolean;
  /** Runs with an open or resolved finding from this check. */
  checkId?: string;
  /** Runs with an open finding. */
  hasOpenFinding?: boolean;
  /** Runs with a span of this kind (LLM, TOOL, ...) whose tool name and model contain these, ignoring case. */
  spanKind?: string;
  tool?: string;
  model?: string;
  text?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  offset?: number;
  includeDoctor?: boolean;
}

type AggregateSpan = Pick<SpanRow, "is_marker" | "span_kind" | "status_code" | "prompt_tokens" | "completion_tokens" | "total_tokens">;

interface RunContribution {
  spans: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const NO_RUN_CONTRIBUTION: RunContribution = {
  spans: 0,
  llmCalls: 0,
  toolCalls: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function runContribution(span: AggregateSpan): RunContribution {
  if (span.is_marker) return NO_RUN_CONTRIBUTION;
  const llm = span.span_kind === "LLM";
  return {
    spans: 1,
    llmCalls: llm ? 1 : 0,
    toolCalls: span.span_kind === "TOOL" || span.span_kind === "MCP_TOOL" ? 1 : 0,
    errors: span.status_code === 2 ? 1 : 0,
    promptTokens: llm ? (span.prompt_tokens ?? 0) : 0,
    completionTokens: llm ? (span.completion_tokens ?? 0) : 0,
    totalTokens: llm ? (span.total_tokens ?? 0) : 0,
  };
}

function nsToMs(ns: string): number {
  if (!ns || ns === "0") return 0;
  // Keep sub-millisecond precision without losing the int64.
  const big = BigInt(ns);
  return Number(big / 1000n) / 1000;
}

function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const REQUEST_KEYS = ["request", "question", "query", "input", "message", "prompt", "task", "goal", "text"];

/**
 * What a run was asked, when its input shows it: a request-like field, or the last user message
 * of a chat history. A chat turn's input usually carries the whole history first, so a plain
 * preview would show old turns and cut off the current request.
 */
export function currentRequest(v: Parameters<typeof preview>[0]): string | undefined {
  const lastUser = (a: unknown[]): string | undefined => {
    for (let i = a.length - 1; i >= 0; i--) {
      const m = a[i] as Record<string, unknown> | null;
      if (m && typeof m === "object" && m.role === "user") return typeof m.content === "string" ? m.content : preview(m.content as never, 300);
    }
    return undefined;
  };
  if (Array.isArray(v)) return lastUser(v)?.slice(0, 300);
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const key = REQUEST_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
  if (key) return (o[key] as string).trim().slice(0, 300);
  for (const val of Object.values(o)) if (Array.isArray(val)) { const u = lastUser(val); if (u) return u.slice(0, 300); }
  return undefined;
}

/** Search covers this much of each input, output and error: the start and the end of long values. */
export const SEARCH_LIMIT = { head: 150_000, tail: 50_000 };
const SEARCH_INDEX_VERSION = 2;
/** A store over its size cap is trimmed to this share of the cap, so it isn't trimmed every hour. */
export const RETENTION_LOW_WATER = 0.9;

/** Free text as an FTS5 query: each word quoted, so operators and punctuation match literally. */
function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * A LIKE pattern for text anywhere in a column. Wildcards are escaped so a literal % or _ is
 * matched as text, not as "match anything"; the ESCAPE '\' clauses that use it pair with this.
 */
function likeText(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function searchText(v: Parameters<typeof preview>[0]): string {
  if (v === undefined || v === null) return "";
  const s = preview(v, Number.MAX_SAFE_INTEGER);
  return s.length <= SEARCH_LIMIT.head + SEARCH_LIMIT.tail ? s : `${s.slice(0, SEARCH_LIMIT.head)}\n…\n${s.slice(-SEARCH_LIMIT.tail)}`;
}

export class Store {
  readonly db: Database.Database;
  readonly blobs: BlobStore;
  private readonly searchIds: SearchIds;
  private seq = 0;
  readonly dir: string;
  readonly file: string;

  /** neatroots.db; a store created before the rename keeps using its bolts.db. */
  static dbFile(dir: string): string {
    const current = path.join(dir, "neatroots.db");
    const legacy = path.join(dir, "bolts.db");
    return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
  }

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = Store.dbFile(dir);
    this.db = new Database(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
    this.searchIds = new SearchIds(this.db);
    this.blobs = new BlobStore(path.join(dir, "blobs"));
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM spans").get() as { s: number | null };
    this.seq = row.s ?? 0;
  }

  close(): void {
    this.db.close();
  }

  /** Adds columns introduced after a database was first created. */
  private migrate(): void {
    const ensure = (table: string, column: string, type: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    ensure("plans", "body", "TEXT");
    // Tool-result labels recorded before the rename to neatroots.
    this.db.prepare("UPDATE decisions SET check_id = 'neatroots.tool-result' WHERE check_id IN ('bolts.tool-result', 'neatbolt.tool-result')").run();
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }

  // ------------------------------------------------------------------ ingest

  private upsertResource(r: OtlpResource): string {
    const body = JSON.stringify(r);
    const id = sha256(body).slice(0, 24);
    this.db.prepare("INSERT OR IGNORE INTO resources (id, json) VALUES (?, ?)").run(id, body);
    return id;
  }

  private upsertScope(s: OtlpScope): string {
    const body = JSON.stringify(s);
    const id = sha256(body).slice(0, 24);
    this.db.prepare("INSERT OR IGNORE INTO scopes (id, json) VALUES (?, ?)").run(id, body);
    return id;
  }

  getResource(id: string): OtlpResource {
    const r = this.db.prepare("SELECT json FROM resources WHERE id = ?").get(id) as { json: string } | undefined;
    return json<OtlpResource>(r?.json, { attributes: [] });
  }

  /** The resources a run's spans were sent with (one per sender, usually one). */
  resourcesFor(traceId: string): OtlpResource[] {
    const rows = this.db.prepare("SELECT DISTINCT resource_id FROM spans WHERE trace_id = ?").all(traceId) as { resource_id: string }[];
    return rows.map((r) => this.getResource(r.resource_id));
  }

  getScope(id: string): OtlpScope {
    const r = this.db.prepare("SELECT json FROM scopes WHERE id = ?").get(id) as { json: string } | undefined;
    return json<OtlpScope>(r?.json, { name: "" });
  }

  /** Stores spans losslessly and updates run, session and search rows. */
  ingest(batches: ResourceSpansBatch[]): TraceUpdate[] {
    const updates = new Map<string, TraceUpdate>();
    const supersededBlobs = new Set<string>();
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const b of batches) {
        const resourceId = this.upsertResource(b.resource);
        const scopeId = this.upsertScope(b.scope);
        const resAttrs = kvToPlain(b.resource.attributes);
        for (const span of b.spans) {
          const view = buildView(span, b.resource.attributes);
          const previous = this.db
            .prepare(
              `SELECT is_marker, span_kind, status_code, prompt_tokens, completion_tokens, total_tokens, blobs
               FROM spans WHERE trace_id = ? AND span_id = ?`,
            )
            .get(span.traceId, span.spanId) as (AggregateSpan & { blobs: string | null }) | undefined;
          const previousBlobs = json<unknown>(previous?.blobs, null);
          if (Array.isArray(previousBlobs)) {
            for (const sha of previousBlobs) {
              if (typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) supersededBlobs.add(sha);
            }
          }
          let u = updates.get(span.traceId);
          if (!u) {
            u = { traceId: span.traceId, spans: [], runCreated: false, rootEnded: false, rootHandedBack: false, completed: false };
            updates.set(span.traceId, u);
          }
          const row = this.writeSpan(span, view, resourceId, scopeId, now, !previous);
          u.spans.push({ row, view, isNew: !previous });
          const runFlags = this.updateRun(span, view, row, resAttrs, now, previous);
          if (runFlags.created) u.runCreated = true;
          if (runFlags.rootEnded) u.rootEnded = true;
          if (runFlags.rootHandedBack) u.rootHandedBack = true;
          if (runFlags.completed) u.completed = true;
        }
      }
    });
    tx();
    // Files are reclaimed only after the span replacement commits and no remaining span uses them.
    this.reclaimUnreferencedBlobs(supersededBlobs);
    return [...updates.values()];
  }

  private writeSpan(span: OtlpSpan, view: SpanView, resourceId: string, scopeId: string, now: number, isNew: boolean): SpanRow {
    const used = new Set<string>();
    const attributes = this.blobs.offload(span.attributes, used);
    const events = span.events.map((e) => ({ ...e, attributes: this.blobs.offload(e.attributes, used) }));
    const startMs = nsToMs(span.startTimeUnixNano);
    // An end of 0 means the span hasn't ended (OTLP); an end before the start is a clock or exporter
    // bug. Both are stored as lasting 0 ms (end_ns keeps the raw value), never as negative.
    const endMs = Math.max(nsToMs(span.endTimeUnixNano) || startMs, startMs);
    const extra = {
      traceState: span.traceState,
      flags: span.flags,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    };
    const row: SpanRow = {
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId || null,
      name: span.name,
      span_kind: view.kind,
      otel_kind: span.kind,
      start_ns: span.startTimeUnixNano,
      end_ns: span.endTimeUnixNano,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: Math.max(0, endMs - startMs),
      status_code: span.status.code,
      status_message: span.status.message != null ? (typeof span.status.message === "string" ? span.status.message : JSON.stringify(span.status.message)) : null,
      model: view.model ?? null,
      provider: view.provider ?? null,
      tool_name: view.toolName ?? null,
      prompt_tokens: view.promptTokens ?? null,
      completion_tokens: view.completionTokens ?? null,
      total_tokens: view.totalTokens ?? null,
      input_preview: view.input !== undefined ? preview(view.input, 600) : null,
      output_preview: view.output !== undefined ? preview(view.output, 600) : null,
      error: view.error ?? null,
      is_marker: view.isMarker ? 1 : 0,
      resource_id: resourceId,
      scope_id: scopeId,
      received_ms: now,
      seq: ++this.seq,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO spans (trace_id, span_id, parent_span_id, name, span_kind, otel_kind, start_ns, end_ns,
          start_ms, end_ms, duration_ms, status_code, status_message, model, provider, tool_name, prompt_tokens,
          completion_tokens, total_tokens, input_preview, output_preview, error, attributes, events, links, extra, blobs,
          is_marker, resource_id, scope_id, received_ms, seq)
         VALUES (@trace_id, @span_id, @parent_span_id, @name, @span_kind, @otel_kind, @start_ns, @end_ns, @start_ms,
          @end_ms, @duration_ms, @status_code, @status_message, @model, @provider, @tool_name, @prompt_tokens,
          @completion_tokens, @total_tokens, @input_preview, @output_preview, @error, @attributes, @events, @links,
          @extra, @blobs, @is_marker, @resource_id, @scope_id, @received_ms, @seq)`,
      )
      .run({
        ...row,
        attributes: JSON.stringify(attributes),
        events: JSON.stringify(events),
        links: JSON.stringify(span.links),
        extra: JSON.stringify(extra),
        blobs: used.size ? JSON.stringify([...used]) : null,
      });
    if (!view.isMarker) {
      this.indexSpan(span.traceId, span.spanId, span.name, view, !isNew);
    }
    return row;
  }

  /** Whether a span id is already stored for this trace. */
  private spanStored(traceId: string, spanId: string): boolean {
    return this.db.prepare("SELECT 1 FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) !== undefined;
  }

  /**
   * Whether a stored span has a parent outside the trace, which means it only became the root
   * through the remote-parent read (#157). A root without a parent id never qualifies.
   */
  private rootCameFromRemoteParent(traceId: string, spanId: string): boolean {
    const row = this.db.prepare("SELECT parent_span_id FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { parent_span_id: string | null } | undefined;
    return !!row?.parent_span_id;
  }

  private updateRun(
    span: OtlpSpan,
    view: SpanView,
    row: SpanRow,
    resAttrs: Record<string, Plain>,
    now: number,
    previous: AggregateSpan | undefined,
  ): { created: boolean; rootEnded: boolean; rootHandedBack: boolean; completed: boolean } {
    const flags = { created: false, rootEnded: false, rootHandedBack: false, completed: false };
    let run = this.getRun(span.traceId);
    if (!run) {
      const project = String(resAttrs["service.name"] ?? view.workflow ?? "unknown");
      this.db
        .prepare(
          `INSERT INTO runs (trace_id, project, workflow, status, started_ms, last_span_ms, received_ms, updated_ms, doctor)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        )
        .run(
          span.traceId,
          project,
          view.workflow ?? project,
          row.start_ms,
          row.end_ms,
          now,
          now,
          resAttrs["neatlogs.doctor"] === true ? 1 : 0,
        );
      flags.created = true;
      run = this.getRun(span.traceId)!;
    }
    const sets: string[] = ["updated_ms = @now", "last_span_ms = MAX(COALESCE(last_span_ms, 0), @end)"];
    const p: Record<string, unknown> = { now, end: row.end_ms, trace: span.traceId };
    if (!run.started_ms || row.start_ms < run.started_ms) {
      sets.push("started_ms = @start");
      p.start = row.start_ms;
    }
    if (view.isMarker) {
      if (!run.complete) {
        sets.push("complete = 1");
        flags.completed = true;
        if (!run.root_ended && run.status === "running") {
          sets.push("ended_ms = COALESCE(ended_ms, @end)");
        }
      }
    }
    const before = previous ? runContribution(previous) : NO_RUN_CONTRIBUTION;
    const afterContribution = runContribution(row);
    const addDelta = (column: string, parameter: string, next: number, prior: number) => {
      const delta = next - prior;
      if (!delta) return;
      sets.push(`${column} = ${column} + @${parameter}`);
      p[parameter] = delta;
    };
    addDelta("span_count", "spanDelta", afterContribution.spans, before.spans);
    addDelta("llm_calls", "llmDelta", afterContribution.llmCalls, before.llmCalls);
    addDelta("tool_calls", "toolDelta", afterContribution.toolCalls, before.toolCalls);
    addDelta("error_count", "errorDelta", afterContribution.errors, before.errors);
    addDelta("prompt_tokens", "promptDelta", afterContribution.promptTokens, before.promptTokens);
    addDelta("completion_tokens", "completionDelta", afterContribution.completionTokens, before.completionTokens);
    addDelta("total_tokens", "totalDelta", afterContribution.totalTokens, before.totalTokens);
    if (view.interrupted) {
      sets.push("interrupted = 1", "status = 'interrupted'");
      if (view.terminationReason) {
        sets.push("termination_reason = @reason");
        p.reason = view.terminationReason;
      }
    }
    // A span is the run's top when it has no parent, or when it declares a remote parent that never
    // reached this trace (#157). A remote parent on its own isn't enough. With propagated context
    // both processes export here, so the callee's top span carries a remote parent while the
    // caller's parentless span sits in the same trace; taking the callee as the root ends the run on
    // it while the caller is still open, which fires end-of-run work too early. A run that already
    // has a root keeps it: only a parentless span can take that place, or the root itself being
    // re-sent (a streaming exporter sends it open first, then with its end).
    const isTop =
      !span.parentSpanId ||
      ((!run.root_span_id || run.root_span_id === span.spanId) && hasRemoteParent(span) && !this.spanStored(span.traceId, span.parentSpanId));
    // Exporters that send a span when it ends (the OTel default) deliver the callee before the
    // caller, so the run ended on a span whose parent simply had not arrived yet. The caller's own
    // span is the real root, and taking it back has to undo that end: while the caller is open the
    // run is running again, and once the caller ends the run ends on the full trace rather than on
    // the callee's slice of it.
    const handedBack = !span.parentSpanId && !!run.root_span_id && this.rootCameFromRemoteParent(span.traceId, run.root_span_id);
    if (isTop && !view.isMarker) {
      // Reported only when the root is really replaced: a parentless marker doesn't take it.
      if (handedBack) flags.rootHandedBack = true;
      sets.push("root_span_id = @root", "root_name = @rootName", "input_preview = @inp", "output_preview = @out");
      p.root = span.spanId;
      p.rootName = span.name;
      p.inp = view.input !== undefined ? (currentRequest(view.input) ?? preview(view.input, 300)) : null;
      p.out = view.output !== undefined ? preview(view.output, 300) : null;
      if (view.workflow) {
        sets.push("workflow = @wf");
        p.wf = view.workflow;
      }
      // A root sent before it ended (end time 0) names the run but doesn't finish it.
      if (nsToMs(span.endTimeUnixNano) > 0) {
        sets.push("root_ended = 1", "ended_ms = @end");
        if (!view.interrupted && run.status !== "interrupted") {
          sets.push("status = @status");
          p.status = span.status.code === 2 ? "error" : "ok";
        }
        // A hand-back reports the end again even though the run already had one: end-of-run checks
        // and forwarding ran on the callee's spans, and they have to run on the full trace now.
        if (handedBack || !run.root_ended) flags.rootEnded = true;
      } else if (handedBack && !view.interrupted && run.status !== "interrupted") {
        sets.push("root_ended = 0", "ended_ms = NULL", "status = 'running'");
      }
    }
    // A re-sent root reports the same session again (a streaming exporter sends it open, then with
    // its end): the session's last-seen moves, but the run is not counted in it twice.
    let sessionSeen = false;
    if (view.sessionId && (!run.session_id || isTop)) {
      if (view.sessionId !== run.session_id) {
        sets.push("session_id = @session");
        p.session = view.sessionId;
      } else {
        sessionSeen = true;
      }
    }
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE trace_id = @trace`).run(p);
    const after = this.getRun(span.traceId)!;
    const sessionId = after.session_id ?? after.trace_id;
    if (flags.created || p.session || sessionSeen) this.touchSession(sessionId, after, now, flags.created || !!p.session);
    return flags;
  }

  private touchSession(id: string, run: RunRow, now: number, countRun: boolean): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project, workflow, first_seen_ms, last_seen_ms, run_count) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms${countRun ? ", run_count = run_count + 1" : ""}`,
      )
      .run(id, run.project, run.workflow, now, now);
  }

  ingestLogs(records: OtlpLogRecord[]): number {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const r of records) {
        const resourceId = this.upsertResource(r.resource);
        const body = kvToPlain([{ key: "b", value: r.body }]).b;
        this.db
          .prepare(
            "INSERT INTO logs (trace_id, span_id, time_ns, severity, body, attributes, resource_id, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            r.traceId || null,
            r.spanId || null,
            r.timeUnixNano,
            r.severityText ?? (r.severityNumber !== undefined ? String(r.severityNumber) : null),
            typeof body === "string" ? body : JSON.stringify(body),
            JSON.stringify(r.attributes),
            resourceId,
            now,
          );
      }
    });
    tx();
    return records.length;
  }

  // ------------------------------------------------------------------- reads

  getRun(traceId: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE trace_id = ?").get(traceId) as RunRow | undefined;
  }

  /** The WHERE clauses and parameters for a run filter, shared by listing and counting. */
  private runFilter(f: RunFilter): { where: string[]; p: Record<string, unknown> } {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (!f.includeDoctor) where.push("doctor = 0");
    if (f.project) {
      where.push("project = @project");
      p.project = f.project;
    }
    if (f.workflow) {
      where.push("workflow = @workflow");
      p.workflow = f.workflow;
    }
    if (f.status) {
      where.push("status = @status");
      p.status = f.status;
    }
    if (f.sessionId) {
      where.push("session_id = @session");
      p.session = f.sessionId;
    }
    if (f.hasFinding !== undefined) {
      where.push(f.hasFinding ? "finding_count > 0" : "finding_count = 0");
    }
    if (f.hasOpenFinding) where.push("open_finding_count > 0");
    if (f.checkId) {
      where.push("trace_id IN (SELECT trace_id FROM findings WHERE check_id = @check AND status NOT IN ('dismissed', 'failed', 'quiet'))");
      p.check = f.checkId;
    }
    const span: string[] = [];
    if (f.spanKind) {
      span.push("s.span_kind = @kind");
      p.kind = f.spanKind;
    }
    if (f.tool) {
      span.push("s.tool_name LIKE @tool ESCAPE '\\'");
      p.tool = likeText(f.tool);
    }
    if (f.model) {
      span.push("s.model LIKE @model ESCAPE '\\'");
      p.model = likeText(f.model);
    }
    if (span.length && !f.text) where.push(`trace_id IN (SELECT s.trace_id FROM spans s WHERE s.is_marker = 0 AND ${span.join(" AND ")})`);
    if (f.sinceMs) {
      where.push("started_ms >= @since");
      p.since = f.sinceMs;
    }
    if (f.untilMs) {
      where.push("started_ms <= @until");
      p.until = f.untilMs;
    }
    if (f.text) {
      // Match the full-text index inside this query, so every matching run can be listed and
      // paged newest first. (Taking the best-ranked 500 spans first dropped matching runs whose
      // match ranked low, even the newest one.)
      const match = ftsQuery(f.text);
      const indexed = !!match && this.ftsQueryOk(match);
      if (span.length) {
        // With span filters the text must match a span that passes them: tool:issue_refund timeout means the
        // refund call mentions "timeout". Without the index there is no per-span text to match, as before.
        // INDEXED BY: probing the wide span rows for every text match is about twice as slow on a large store.
        where.push(indexed ? `trace_id IN (SELECT s.trace_id FROM spans s INDEXED BY spans_filter WHERE ${span.join(" AND ")} AND (s.trace_id, s.span_id) IN (${this.searchIds.matching("trace_id, span_id")}))` : "0");
        if (indexed) p.match = match;
        return { where, p };
      }
      const like = likeText(f.text);
      where.push(`(${indexed ? `trace_id IN (${this.searchIds.matching("trace_id")}) OR ` : ""}root_name LIKE @like ESCAPE '\\' OR workflow LIKE @like ESCAPE '\\' OR input_preview LIKE @like ESCAPE '\\' OR output_preview LIKE @like ESCAPE '\\')`);
      if (indexed) p.match = match;
      p.like = like;
    }
    return { where, p };
  }

  listRuns(f: RunFilter = {}): RunRow[] {
    const { where, p } = this.runFilter(f);
    const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(started_ms, received_ms) DESC LIMIT @limit OFFSET @offset`;
    p.limit = Number.isFinite(f.limit) ? Math.min(Math.max(Math.trunc(f.limit as number), 1), 500) : 50;
    p.offset = Number.isFinite(f.offset) ? Math.max(Math.trunc(f.offset as number), 0) : 0;
    return this.db.prepare(sql).all(p) as RunRow[];
  }

  /** How many runs a filter matches, whatever the page size. */
  countMatchingRuns(f: RunFilter = {}): number {
    const { where, p } = this.runFilter(f);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(p) as { n: number }).n;
  }

  countRuns(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE doctor = 0").get() as { n: number }).n;
  }

  getSpans(traceId: string, includeMarker = false): SpanRow[] {
    return this.db
      .prepare(
        `SELECT trace_id, span_id, parent_span_id, name, span_kind, otel_kind, start_ns, end_ns, start_ms, end_ms,
          duration_ms, status_code, status_message, model, provider, tool_name, prompt_tokens, completion_tokens,
          total_tokens, input_preview, output_preview, error, is_marker, resource_id, scope_id, received_ms, seq
         FROM spans WHERE trace_id = ? ${includeMarker ? "" : "AND is_marker = 0"} ORDER BY start_ms, seq`,
      )
      .all(traceId) as SpanRow[];
  }

  getSpanRow(traceId: string, spanId: string): SpanRow | undefined {
    return this.getSpans(traceId, true).find((s) => s.span_id === spanId);
  }

  /** Reassembles a stored span as OTLP, restoring blob payloads. */
  getOtlpSpan(traceId: string, spanId: string): { span: OtlpSpan; resource: OtlpResource; scope: OtlpScope } | undefined {
    const r = this.db.prepare("SELECT * FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as
      | (SpanRow & { attributes: string; events: string; links: string; extra: string | null })
      | undefined;
    if (!r) return undefined;
    return { span: this.rowToOtlp(r), resource: this.getResource(r.resource_id), scope: this.getScope(r.scope_id) };
  }

  private rowToOtlp(r: SpanRow & { attributes: string; events: string; links: string; extra: string | null }): OtlpSpan {
    const extra = json<Record<string, unknown>>(r.extra, {});
    const events = json<OtlpSpan["events"]>(r.events, []).map((e) => ({ ...e, attributes: this.blobs.rehydrate(e.attributes) }));
    return {
      traceId: r.trace_id,
      spanId: r.span_id,
      parentSpanId: r.parent_span_id ?? "",
      traceState: extra.traceState as string | undefined,
      flags: extra.flags as number | undefined,
      name: r.name,
      kind: r.otel_kind,
      startTimeUnixNano: r.start_ns,
      endTimeUnixNano: r.end_ns,
      attributes: this.blobs.rehydrate(json<KeyValue[]>(r.attributes, [])),
      droppedAttributesCount: extra.droppedAttributesCount as number | undefined,
      events,
      droppedEventsCount: extra.droppedEventsCount as number | undefined,
      links: json(r.links, []),
      droppedLinksCount: extra.droppedLinksCount as number | undefined,
      status: { code: r.status_code, message: r.status_message ?? undefined },
    };
  }

  /** All stored spans of the given traces, grouped by resource and scope, ready for OTLP export. */
  batchesForTraces(traceIds: string[]): ResourceSpansBatch[] {
    const groups = new Map<string, ResourceSpansBatch>();
    for (const traceId of traceIds) {
      const rows = this.db.prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY seq").all(traceId) as (SpanRow & {
        attributes: string;
        events: string;
        links: string;
        extra: string | null;
      })[];
      for (const r of rows) {
        const key = `${r.resource_id}:${r.scope_id}`;
        let g = groups.get(key);
        if (!g) {
          g = { resource: this.getResource(r.resource_id), scope: this.getScope(r.scope_id), spans: [] };
          groups.set(key, g);
        }
        g.spans.push(this.rowToOtlp(r));
      }
    }
    return [...groups.values()];
  }

  /**
   * Best-ranked spans matching `text`. With `traceIds`, only spans from those runs, in stored order:
   * ranking would score every match in the store, which costs more than the rest of a search.
   */
  searchSpans(text: string, limit = 50, traceIds?: string[]): { trace_id: string; span_id: string; name: string; snippet: string }[] {
    const q = ftsQuery(text);
    if (!q) return [];
    try {
      return this.db
        .prepare(
          `SELECT trace_id, span_id, name, snippet(span_fts, 4, '[', ']', '…', 12) AS snippet
           FROM span_fts WHERE span_fts MATCH ? ${traceIds ? `AND ${this.searchIds.inRuns(traceIds.length)}` : "ORDER BY rank"} LIMIT ?`,
        )
        .all(q, ...(traceIds ?? []), limit) as { trace_id: string; span_id: string; name: string; snippet: string }[];
    } catch {
      return [];
    }
  }

  /** True when `match` parses as a full-text query (so it can go inside a larger query safely). */
  private ftsQueryOk(match: string): boolean {
    try {
      this.db.prepare("SELECT 1 FROM span_fts WHERE span_fts MATCH ? LIMIT 1").get(match);
      return true;
    } catch {
      return false;
    }
  }

  logsForTrace(traceId: string): { span_id: string | null; time_ns: string; severity: string | null; body: string }[] {
    return this.db
      .prepare("SELECT span_id, time_ns, severity, body FROM logs WHERE trace_id = ? ORDER BY id")
      .all(traceId) as { span_id: string | null; time_ns: string; severity: string | null; body: string }[];
  }

  setPinned(traceId: string, pinned: boolean): void {
    this.db.prepare("UPDATE runs SET pinned = ? WHERE trace_id = ?").run(pinned ? 1 : 0, traceId);
  }

  setRunPlan(traceId: string, planId: string): void {
    this.db.prepare("UPDATE runs SET plan_id = ? WHERE trace_id = ?").run(planId, traceId);
  }

  // ----------------------------------------------------------------- findings

  private findingFromRow(r: Record<string, unknown>): Finding {
    return {
      ...(r as unknown as Finding),
      evidence_span_ids: json<string[]>(r.evidence_span_ids as string, []),
      detail: json<Record<string, Plain>>(r.detail as string, {}),
    };
  }

  insertFinding(f: Omit<Finding, "id" | "created_ms" | "updated_ms"> & { id?: string }): Finding {
    const now = Date.now();
    const finding: Finding = { ...f, id: f.id ?? newId("fnd"), created_ms: now, updated_ms: now };
    this.db
      .prepare(
        `INSERT INTO findings (id, trace_id, check_id, check_kind, title, probability, status, evidence_span_ids, detail,
          model, triage_score, explanation_id, created_ms, updated_ms)
         VALUES (@id, @trace_id, @check_id, @check_kind, @title, @probability, @status, @evidence_span_ids, @detail,
          @model, @triage_score, @explanation_id, @created_ms, @updated_ms)`,
      )
      .run({ ...finding, evidence_span_ids: JSON.stringify(finding.evidence_span_ids), detail: JSON.stringify(finding.detail) });
    this.db.prepare("UPDATE checks SET hits = hits + 1 WHERE id = ?").run(finding.check_id);
    this.refreshFindingCounts(finding.trace_id);
    return finding;
  }

  updateFinding(id: string, patch: Partial<Pick<Finding, "status" | "probability" | "triage_score" | "explanation_id" | "evidence_span_ids" | "detail" | "title">>): Finding | undefined {
    const cur = this.getFinding(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_ms: Date.now() };
    this.db
      .prepare(
        `UPDATE findings SET status = @status, probability = @probability, triage_score = @triage_score,
          explanation_id = @explanation_id, evidence_span_ids = @evidence_span_ids, detail = @detail, title = @title,
          updated_ms = @updated_ms WHERE id = @id`,
      )
      .run({ ...next, evidence_span_ids: JSON.stringify(next.evidence_span_ids), detail: JSON.stringify(next.detail) });
    if (patch.status && patch.status !== cur.status) {
      if (patch.status === "dismissed") this.db.prepare("UPDATE checks SET dismissed = dismissed + 1 WHERE id = ?").run(cur.check_id);
      if (cur.status === "dismissed") this.db.prepare("UPDATE checks SET dismissed = MAX(0, dismissed - 1) WHERE id = ?").run(cur.check_id);
    }
    this.refreshFindingCounts(cur.trace_id);
    return next;
  }

  getFinding(id: string): Finding | undefined {
    const r = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.findingFromRow(r) : undefined;
  }

  /** Title of the most important open finding in a run, for run lists. */
  topOpenFinding(traceId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT title FROM findings WHERE trace_id = ? AND status IN ('raised', 'active') ORDER BY COALESCE(triage_score, 0) DESC, COALESCE(probability, 1) DESC, created_ms LIMIT 1",
      )
      .get(traceId) as { title: string } | undefined;
    return r?.title ?? null;
  }

  findingsForTrace(traceId: string): Finding[] {
    return (this.db.prepare("SELECT * FROM findings WHERE trace_id = ? ORDER BY created_ms").all(traceId) as Record<string, unknown>[]).map((r) =>
      this.findingFromRow(r),
    );
  }

  listFindings(f: { traceId?: string; status?: string; checkId?: string; limit?: number } = {}): Finding[] {
    const where: string[] = [];
    const p: Record<string, unknown> = { limit: Number.isFinite(f.limit) ? Math.min(Math.max(Math.trunc(f.limit as number), 1), 500) : 100 };
    if (f.traceId) {
      where.push("trace_id = @trace");
      p.trace = f.traceId;
    }
    if (f.status) {
      where.push("status = @status");
      p.status = f.status;
    }
    if (f.checkId) {
      where.push("check_id = @check");
      p.check = f.checkId;
    }
    return (
      this.db
        .prepare(`SELECT * FROM findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_ms DESC LIMIT @limit`)
        .all(p) as Record<string, unknown>[]
    ).map((r) => this.findingFromRow(r));
  }

  openFindingFor(traceId: string, checkId: string): Finding | undefined {
    const r = this.db
      .prepare("SELECT * FROM findings WHERE trace_id = ? AND check_id = ? AND status IN ('raised', 'active', 'quiet') ORDER BY created_ms DESC LIMIT 1")
      .get(traceId, checkId) as Record<string, unknown> | undefined;
    return r ? this.findingFromRow(r) : undefined;
  }

  latestFindingFor(traceId: string, checkId: string): Finding | undefined {
    const r = this.db
      .prepare("SELECT * FROM findings WHERE trace_id = ? AND check_id = ? ORDER BY created_ms DESC LIMIT 1")
      .get(traceId, checkId) as Record<string, unknown> | undefined;
    return r ? this.findingFromRow(r) : undefined;
  }

  /**
   * A run's problem counts. Findings of checks in the same group (one retry loop tripping three
   * checks) count once; quiet ones don't count.
   */
  private refreshFindingCounts(traceId: string): void {
    const problem = "COALESCE(json_extract(detail, '$.group'), id)";
    this.db
      .prepare(
        `UPDATE runs SET
          finding_count = (SELECT COUNT(DISTINCT ${problem}) FROM findings WHERE trace_id = @t AND status NOT IN ('failed', 'dismissed', 'quiet')),
          open_finding_count = (SELECT COUNT(DISTINCT ${problem}) FROM findings WHERE trace_id = @t AND status IN ('raised', 'active'))
         WHERE trace_id = @t`,
      )
      .run({ t: traceId });
  }

  /** How often the person dismissed a check's findings in one project. */
  dismissalsIn(checkId: string, project: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM findings f JOIN runs r ON r.trace_id = f.trace_id WHERE f.check_id = ? AND r.project = ? AND f.status = 'dismissed'")
      .get(checkId, project) as { n: number };
    return r.n;
  }

  setFindingStatus(id: string, status: FindingStatus): Finding | undefined {
    return this.updateFinding(id, { status });
  }

  // -------------------------------------------------------------- decisions

  insertDecision(d: Omit<DecisionRow, "id" | "created_ms">): DecisionRow {
    const row: DecisionRow = { ...d, id: newId("dec"), created_ms: Date.now() };
    this.db
      .prepare(
        "INSERT INTO decisions (id, trace_id, check_id, span_id, probability, answer, backend, latency_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.trace_id, row.check_id, row.span_id, row.probability, JSON.stringify(row.answer), row.backend, row.latency_ms, row.created_ms);
    return row;
  }

  decisionsForTrace(traceId: string): DecisionRow[] {
    return (this.db.prepare("SELECT * FROM decisions WHERE trace_id = ? ORDER BY created_ms").all(traceId) as Record<string, unknown>[]).map(
      (r) => ({ ...(r as unknown as DecisionRow), answer: json(r.answer as string, null) }),
    );
  }

  // ------------------------------------------------------------ explanations

  insertExplanation(e: Omit<Explanation, "id" | "created_ms">): Explanation {
    const row: Explanation = { ...e, id: newId("exp"), created_ms: Date.now() };
    this.db
      .prepare(
        `INSERT INTO explanations (id, target_type, target_id, trace_id, cause, fix, evidence_span_ids, grounding, model, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.target_type, row.target_id, row.trace_id, row.cause, row.fix, JSON.stringify(row.evidence_span_ids), row.grounding, row.model, row.created_ms);
    return row;
  }

  getExplanation(id: string): Explanation | undefined {
    const r = this.db.prepare("SELECT * FROM explanations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as Explanation), evidence_span_ids: json(r.evidence_span_ids as string, []) } : undefined;
  }

  explanationFor(targetType: "finding" | "run", targetId: string): Explanation | undefined {
    const r = this.db
      .prepare("SELECT * FROM explanations WHERE target_type = ? AND target_id = ? ORDER BY created_ms DESC LIMIT 1")
      .get(targetType, targetId) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as Explanation), evidence_span_ids: json(r.evidence_span_ids as string, []) } : undefined;
  }

  // ------------------------------------------------------------------- notes

  insertNote(n: Omit<Note, "id" | "created_ms" | "delivered_ms" | "delivered_span_id" | "replaced_by"> & { id?: string }): Note {
    const note: Note = {
      ...n,
      id: n.id ?? newId("note"),
      created_ms: Date.now(),
      delivered_ms: null,
      delivered_span_id: null,
      replaced_by: null,
    };
    this.db
      .prepare(
        `INSERT INTO notes (id, trace_id, finding_id, kind, text, status, created_ms, delivered_ms, delivered_span_id, replaced_by, checks)
         VALUES (@id, @trace_id, @finding_id, @kind, @text, @status, @created_ms, @delivered_ms, @delivered_span_id, @replaced_by, @checks)`,
      )
      .run({ ...note, checks: note.checks ? JSON.stringify(note.checks) : null });
    return note;
  }

  private noteFromRow(r: Record<string, unknown>): Note {
    return { ...(r as unknown as Note), checks: json(r.checks as string, null) };
  }

  getNote(id: string): Note | undefined {
    const r = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.noteFromRow(r) : undefined;
  }

  notesForTrace(traceId: string, status?: NoteStatus): Note[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM notes WHERE trace_id = ? AND status = ? ORDER BY created_ms").all(traceId, status)
      : this.db.prepare("SELECT * FROM notes WHERE trace_id = ? ORDER BY created_ms").all(traceId);
    return (rows as Record<string, unknown>[]).map((r) => this.noteFromRow(r));
  }

  updateNote(id: string, patch: Partial<Pick<Note, "status" | "delivered_ms" | "delivered_span_id" | "replaced_by" | "checks" | "text">>): void {
    const cur = this.getNote(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        "UPDATE notes SET status = @status, delivered_ms = @delivered_ms, delivered_span_id = @delivered_span_id, replaced_by = @replaced_by, checks = @checks, text = @text WHERE id = @id",
      )
      .run({ ...next, checks: next.checks ? JSON.stringify(next.checks) : null });
  }

  // --------------------------------------------------------------- summaries

  setSummary(traceId: string, text: string, model: string | null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO summaries (trace_id, text, model, created_ms) VALUES (?, ?, ?, ?)")
      .run(traceId, text, model, Date.now());
  }

  getSummary(traceId: string): { text: string; model: string | null; created_ms: number } | undefined {
    return this.db.prepare("SELECT text, model, created_ms FROM summaries WHERE trace_id = ?").get(traceId) as
      | { text: string; model: string | null; created_ms: number }
      | undefined;
  }

  // ------------------------------------------------------------------- plans

  insertPlan(p: Omit<PlanRow, "id" | "created_ms">): PlanRow {
    const row: PlanRow = { ...p, id: newId("plan"), created_ms: Date.now() };
    this.db
      .prepare("INSERT INTO plans (id, workflow, created_ms, created_by, model, rationale, check_ids, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.workflow, row.created_ms, row.created_by, row.model, row.rationale, JSON.stringify(row.check_ids), JSON.stringify({ params: row.params, tools: row.tools }));
    return row;
  }

  private planFromRow(r: Record<string, unknown>): PlanRow {
    const body = json<{ params?: PlanRow["params"]; tools?: string[] }>(r.body as string, {});
    return {
      ...(r as unknown as PlanRow),
      check_ids: json(r.check_ids as string, []),
      params: body.params ?? {},
      tools: body.tools ?? [],
    };
  }

  latestPlan(workflow: string): PlanRow | undefined {
    const r = this.db.prepare("SELECT * FROM plans WHERE workflow = ? ORDER BY created_ms DESC LIMIT 1").get(workflow) as
      | Record<string, unknown>
      | undefined;
    return r ? this.planFromRow(r) : undefined;
  }

  getPlan(id: string): PlanRow | undefined {
    const r = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.planFromRow(r) : undefined;
  }

  listPlans(limit = 50): PlanRow[] {
    return (this.db.prepare("SELECT * FROM plans ORDER BY created_ms DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => this.planFromRow(r));
  }

  // ------------------------------------------------------------------ checks

  upsertCheckRow(c: { id: string; kind: string; source: string; path: string | null; body: string; enabled?: boolean }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO checks (id, kind, source, path, body, enabled, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, source = excluded.source, path = excluded.path, body = excluded.body, updated_ms = excluded.updated_ms`,
      )
      .run(c.id, c.kind, c.source, c.path, c.body, c.enabled === false ? 0 : 1, now, now);
  }

  checkStats(): Record<string, { hits: number; dismissed: number; confirmed: number; enabled: number }> {
    const rows = this.db.prepare("SELECT id, hits, dismissed, confirmed, enabled FROM checks").all() as {
      id: string;
      hits: number;
      dismissed: number;
      confirmed: number;
      enabled: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  setCheckEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE checks SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  bumpConfirmed(checkId: string): void {
    this.db.prepare("UPDATE checks SET confirmed = confirmed + 1 WHERE id = ?").run(checkId);
  }

  // ------------------------------------------------------------- annotations

  insertAnnotation(a: Omit<Annotation, "id" | "created_ms">): Annotation {
    const row: Annotation = { ...a, id: newId("ann"), created_ms: Date.now() };
    this.db
      .prepare("INSERT INTO annotations (id, trace_id, span_id, label, text, author, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.trace_id, row.span_id, row.label, row.text, row.author, row.created_ms);
    return row;
  }

  annotationsForTrace(traceId: string): Annotation[] {
    return this.db.prepare("SELECT * FROM annotations WHERE trace_id = ? ORDER BY created_ms").all(traceId) as Annotation[];
  }

  // ---------------------------------------------------------------- forwards

  insertForward(f: Omit<ForwardRow, "id" | "created_ms">): ForwardRow {
    const row: ForwardRow = { ...f, id: newId("fwd"), created_ms: Date.now() };
    this.db
      .prepare(
        `INSERT INTO forwards (id, trace_ids, endpoint, status, http_status, span_count, bytes, redactions, error, initiated_by, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, JSON.stringify(row.trace_ids), row.endpoint, row.status, row.http_status, row.span_count, row.bytes, row.redactions, row.error, row.initiated_by, row.created_ms);
    return row;
  }

  listForwards(limit = 50): ForwardRow[] {
    return (this.db.prepare("SELECT * FROM forwards ORDER BY created_ms DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
      ...(r as unknown as ForwardRow),
      trace_ids: json(r.trace_ids as string, []),
    }));
  }

  forwardedTraceIds(): Set<string> {
    const rows = this.db.prepare("SELECT trace_ids FROM forwards WHERE status = 'ok'").all() as { trace_ids: string }[];
    const out = new Set<string>();
    for (const r of rows) for (const t of json<string[]>(r.trace_ids, [])) out.add(t);
    return out;
  }

  // ----------------------------------------------------------------- uploads

  insertUpload(u: { id: string; sha256: string | null; mime_type: string | null; byte_length: number | null; purpose: string | null; state: string }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO uploads (id, sha256, mime_type, byte_length, purpose, state, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(u.id, u.sha256, u.mime_type, u.byte_length, u.purpose, u.state, Date.now());
  }

  getUpload(id: string): { id: string; sha256: string | null; mime_type: string | null; byte_length: number | null; purpose: string | null; state: string; blob_sha: string | null } | undefined {
    return this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as never;
  }

  setUploadState(id: string, state: string, blobSha?: string): void {
    this.db.prepare("UPDATE uploads SET state = ?, blob_sha = COALESCE(?, blob_sha) WHERE id = ?").run(state, blobSha ?? null, id);
  }

  // --------------------------------------------------------------- retention

  /** Deletes the oldest unpinned runs past the age or size limit. Returns how many runs were removed. */
  sweep(maxAgeDays: number, maxBytes: number): number {
    let removed = 0;
    // Skip the age sweep for a non-positive age: a cutoff of "now" (days = 0)
    // would delete every unpinned run. maxBytes pruning below still runs.
    if (Number.isFinite(maxAgeDays) && maxAgeDays >= 1) {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      const old = this.db
        .prepare("SELECT trace_id FROM runs WHERE pinned = 0 AND COALESCE(ended_ms, received_ms) < ?")
        .all(cutoff) as { trace_id: string }[];
      this.deleteRuns(old.map((r) => r.trace_id));
      removed += old.length;
    }
    // Measure what the database holds, not the file size: SQLite keeps the file (and WAL) at its
    // high-water mark after a delete and reuses the freed pages, so the file size never drops
    // after a delete and measuring it would delete every unpinned run.
    let size = this.storedBytes();
    if (size > maxBytes) {
      // Deleting from the full-text index leaves "deleted" markers until it is compacted, so the
      // size can read high. Compact (once per sweep, and only when over the cap) before trusting it.
      this.compactSearchIndex();
      size = this.storedBytes();
    }
    if (size > maxBytes) {
      // Trim the oldest unpinned runs down to a low-water mark below the cap, so a store sitting
      // at its cap isn't trimmed (and compacted) again on every hourly sweep.
      const oldest = this.oldestRunsCovering(size - maxBytes * RETENTION_LOW_WATER, size);
      this.deleteRuns(oldest);
      removed += oldest.length;
    }
    if (removed) this.db.pragma("wal_checkpoint(TRUNCATE)");
    return removed;
  }

  /**
   * The oldest unpinned runs whose share of storedBytes() adds up to `excess`. A run's span rows
   * are scaled to the database's share of `stored` (which also holds the search index and table
   * overhead). Blobs are shared between runs, so a blob counts only toward the run whose deletion
   * actually frees it: the newest run that references it, and never one a pinned run still uses.
   * Returns at least one run while any unpinned run exists.
   */
  private oldestRunsCovering(excess: number, stored: number): string[] {
    const rowBytes = `octet_length(s.attributes) + octet_length(s.events) + octet_length(s.links) + IFNULL(octet_length(s.extra), 0) + IFNULL(octet_length(s.input_preview), 0) + IFNULL(octet_length(s.output_preview), 0) + octet_length(s.name)`;
    // A big value lives in a blob file but its text is also in the search index, so the
    // indexed text counts toward the run too.
    const indexed = new Map(
      (this.db.prepare("SELECT trace_id AS t, SUM(octet_length(name) + octet_length(tool_name) + octet_length(body)) AS f FROM span_fts GROUP BY trace_id").all() as { t: string; f: number }[]).map((r) => [r.t, r.f]),
    );
    const rows = (
      this.db
        .prepare(
          `SELECT r.trace_id AS t, r.pinned AS pinned, COALESCE(SUM(${rowBytes}), 0) AS w, group_concat(s.blobs, '') AS b
           FROM runs r LEFT JOIN spans s ON s.trace_id = r.trace_id
           GROUP BY r.trace_id ORDER BY COALESCE(r.ended_ms, r.received_ms) ASC`,
        )
        .all() as { t: string; pinned: number; w: number; b: string | null }[]
    ).map((r) => ({ ...r, w: r.w + (indexed.get(r.t) ?? 0) }));
    const shas = rows.map((r) => (r.b ? [...new Set(r.b.match(/[0-9a-f]{64}/g) ?? [])] : []));
    const lastRef = new Map<string, number>();
    shas.forEach((list, i) => list.forEach((sha) => lastRef.set(sha, rows[i].pinned ? Infinity : Math.max(lastRef.get(sha) ?? -1, i))));
    const blobTotal = this.blobs.size();
    const rowTotal = rows.reduce((n, r) => n + r.w, 0);
    // Every table and index keeps at least its root page however many runs are deleted.
    const fixed = (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE rootpage > 0").get() as { n: number }).n * (this.db.pragma("page_size", { simple: true }) as number);
    const rowScale = rowTotal > 0 ? Math.max(0, stored - blobTotal - fixed) / rowTotal : 0;
    const pick: string[] = [];
    let freed = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].pinned) continue;
      pick.push(rows[i].t);
      freed += rows[i].w * rowScale;
      for (const sha of shas[i]) if (lastRef.get(sha) === i) freed += this.blobs.sizeOf(sha);
      if (freed >= excess) break;
    }
    return pick;
  }

  /** Merges the full-text index so space held by deleted spans is actually released. */
  private compactSearchIndex(): void {
    this.db.prepare("INSERT INTO span_fts(span_fts) VALUES('optimize')").run();
  }

  /** Bytes of data actually stored: database pages in use (not free pages) plus payload blobs. */
  storedBytes(): number {
    const pages = this.db.pragma("page_count", { simple: true }) as number;
    const free = this.db.pragma("freelist_count", { simple: true }) as number;
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;
    return (pages - free) * pageSize + this.blobs.size();
  }

  diskBytes(): number {
    let total = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        total += fs.statSync(f).size;
      } catch {
        /* missing */
      }
    }
    return total + this.blobs.size();
  }

  deleteRun(traceId: string): void {
    this.deleteRuns([traceId]);
  }

  /**
   * Deletes runs in one go. Until the search index's run ids are filled in (the first start after
   * an update), deleting from it by run scans the whole index; doing it once for the batch, not
   * once per run, keeps a large retention trim fast.
   */
  deleteRuns(traceIds: string[]): void {
    if (!traceIds.length) return;
    const ids = JSON.stringify(traceIds);
    const inIds = "trace_id IN (SELECT value FROM json_each(?))";
    const shas = (this.db.prepare(`SELECT DISTINCT j.value AS sha FROM spans, json_each(CASE WHEN json_valid(spans.blobs) THEN spans.blobs ELSE '[]' END) AS j WHERE spans.${inIds} AND spans.blobs IS NOT NULL`).all(ids) as { sha: string }[]).map((r) => r.sha);
    const tx = this.db.transaction(() => {
      this.searchIds.deleteRuns(ids);
      for (const t of ["spans", "logs", "findings", "decisions", "explanations", "notes", "summaries", "annotations"]) {
        this.db.prepare(`DELETE FROM ${t} WHERE ${inIds}`).run(ids);
      }
      this.db.prepare(`DELETE FROM runs WHERE ${inIds}`).run(ids);
    });
    tx();
    this.reclaimUnreferencedBlobs(shas);
  }

  /** Deletes candidate payloads only after checking every remaining span reference. */
  private reclaimUnreferencedBlobs(candidates: Iterable<string>): void {
    const shas = [...new Set(candidates)];
    if (!shas.length) return;
    const used = new Set(
      (this.db.prepare("SELECT DISTINCT j.value AS sha FROM spans, json_each(CASE WHEN json_valid(spans.blobs) THEN spans.blobs ELSE '[]' END) AS j WHERE spans.blobs IS NOT NULL AND j.value IN (SELECT value FROM json_each(?))").all(JSON.stringify(shas)) as { sha: string }[]).map((r) => r.sha),
    );
    for (const sha of shas) if (!used.has(sha)) this.blobs.delete(sha);
  }

  stats(): { runs: number; spans: number; findings: number; bytes: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      runs: n("SELECT COUNT(*) AS n FROM runs WHERE doctor = 0"),
      spans: n("SELECT COUNT(*) AS n FROM spans"),
      findings: n("SELECT COUNT(*) AS n FROM findings WHERE status NOT IN ('failed', 'dismissed', 'quiet')"),
      bytes: this.diskBytes(),
    };
  }

  /** Laya-vs-LLM agreement per question, persisted so trust survives restarts. */
  trustStore(): import("../models/decision.js").TrustStore {
    let data: Record<string, { n: number; agree: number }> = json(this.getMeta("laya_trust"), {});
    let timer: NodeJS.Timeout | undefined;
    const persist = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.setMeta("laya_trust", JSON.stringify(data)), 1000);
      timer.unref();
    };
    return {
      get: (q) => data[q] ?? { n: 0, agree: 0 },
      record: (q, agreed) => {
        const cur = data[q] ?? { n: 0, agree: 0 };
        data = { ...data, [q]: { n: cur.n + 1, agree: cur.agree + (agreed ? 1 : 0) } };
        persist();
      },
      all: () => ({ ...data }),
    };
  }

  /** Full-text index for a span: its input, output and error, as much as SEARCH_LIMIT allows. */
  private indexSpan(traceId: string, spanId: string, name: string, view: SpanView, replace = true): void {
    // A span stored for the first time has no index rows yet (they are only deleted with the span).
    if (replace) this.searchIds.deleteSpan(traceId, spanId);
    const body = [searchText(view.input), searchText(view.output), searchText(view.error ?? undefined)].join("\n");
    const { lastInsertRowid } = this.db.prepare("INSERT INTO span_fts (trace_id, span_id, name, tool_name, body) VALUES (?, ?, ?, ?, ?)").run(traceId, spanId, name, view.toolName ?? "", body);
    this.searchIds.add(lastInsertRowid, traceId, spanId);
  }

  /** Fills in the run and span of each search-index row, for a store from an older version. */
  rebuildSearchIds(onDone?: (rows: number, ready: boolean) => void): void {
    this.searchIds.rebuild(onDone);
  }

  /**
   * The search index's startup work, in order: fill in its run ids, then re-index spans stored
   * before search covered whole values. Re-indexing replaces each span's rows, which goes through
   * the run ids once they're in; without them, it scans the whole index for every span. So if the
   * run ids can't be filled in (a locked or failing database), it tries again twice, a minute and
   * then two later, and the re-index waits for them or for the next start.
   */
  maintainSearch(onIds?: (rows: number, ready: boolean) => void, onReindex?: (n: number, ok: boolean) => void, retryMs = 60_000): void {
    const attempt = (tries: number) =>
      this.rebuildSearchIds((rows, ready) => {
        // These run on later turns of the event loop, by when the store may have been closed.
        if (!this.db.open) return;
        if (ready) {
          onIds?.(rows, true);
          if (this.db.open) this.reindexSearch(onReindex);
        } else if (tries < 3) {
          setTimeout(() => this.db.open && attempt(tries + 1), retryMs * tries).unref();
        } else {
          onIds?.(rows, false);
        }
      });
    attempt(1);
  }

  /**
   * Re-indexes spans stored before the index covered whole values (it kept 4,000 characters of
   * each), a few hundred at a time so startup isn't held up. Runs once per database.
   */
  reindexSearch(onDone?: (n: number, ok: boolean) => void): void {
    if (this.getMeta("search_index") === String(SEARCH_INDEX_VERSION)) return;
    let after = 0;
    let n = 0;
    // Each chunk commits as one, so the index and its run ids (span_fts_ids) change together.
    const chunk = this.db.transaction((rows: { seq: number; trace_id: string; span_id: string }[]) => {
      for (const r of rows) {
        const full = this.getOtlpSpan(r.trace_id, r.span_id);
        if (!full) continue;
        const view = buildView(full.span, full.resource.attributes);
        if (view.isMarker) continue;
        this.indexSpan(r.trace_id, r.span_id, full.span.name, view);
        n++;
      }
    });
    const step = () => {
      if (!this.db.open) return;
      try {
        const rows = this.db.prepare("SELECT seq, trace_id, span_id FROM spans WHERE seq > ? ORDER BY seq LIMIT 300").all(after) as { seq: number; trace_id: string; span_id: string }[];
        chunk(rows);
        if (rows.length) {
          after = rows[rows.length - 1].seq;
          setImmediate(step);
          return;
        }
        this.setMeta("search_index", String(SEARCH_INDEX_VERSION));
      } catch {
        // A busy or failing database: stop (a failed chunk rolls back), and start over at the next start.
        onDone?.(n, false);
        return;
      }
      onDone?.(n, true);
    };
    setImmediate(step);
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}
