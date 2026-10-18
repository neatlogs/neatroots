import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { RootsEvents } from "../bus.js";
import type { Roots } from "../core.js";
import { loadTrace, runGoal } from "../engine/trace.js";
import { toBatches, type SpanNode } from "../ingest/build.js";
import type { ChatMessage } from "../models/llm.js";
import type { Plain, ResourceSpansBatch } from "../otlp/types.js";
import type { TraceUpdate } from "../store/db.js";
import { ReplayCorrelation, type Attribution } from "./correlation.js";
import { isSystemRole, preview } from "../semantics/view.js";
import { log } from "../util/log.js";

// Replays. An LLM-call replay re-sends one LLM span's messages (as edited) to the configured LLM
// and stores the answer as a new run; no agent needed. A run replay re-runs the whole agent with
// overrides, through the command or HTTP endpoint registered for its project, and links the run it
// produces. Either way the new run goes through checks like any other, so "did the fix work?" is
// answered by its findings.

export interface ReplayOverrides {
  /** LLM replay: the messages to send instead of the span's. */
  messages?: { role: string; content: string }[];
  /** LLM replay: change one recorded message (matched by its text) and keep the rest. */
  edit?: { from: string; to: string };
  /** Run replay: the user input to run the agent with. */
  input?: string;
  model?: string;
  system?: string;
}

export interface Replay {
  id: string;
  trace_id: string;
  span_id: string | null;
  kind: "llm" | "run";
  via: "llm" | "command" | "http";
  overrides: ReplayOverrides;
  state: "running" | "succeeded" | "failed";
  new_trace_id: string | null;
  attribution: Attribution;
  attribution_reason: string;
  output_preview: string | null;
  error: string | null;
  log_tail: string | null;
  created_ms: number;
  finished_ms: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS replays (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  kind TEXT NOT NULL,
  via TEXT NOT NULL,
  overrides TEXT NOT NULL,
  state TEXT NOT NULL,
  new_trace_id TEXT,
  output_preview TEXT,
  error TEXT,
  log_tail TEXT,
  created_ms INTEGER NOT NULL,
  finished_ms INTEGER
);
CREATE INDEX IF NOT EXISTS replays_trace ON replays (trace_id);
CREATE INDEX IF NOT EXISTS replays_new ON replays (new_trace_id);
`;

type Row = Omit<Replay, "overrides"> & { overrides: string; generated_trace_id?: string | null; output_revoked?: number };

/** Chat messages as neatroots' LLM client takes them; tool turns become plain text. */
export function toChat(messages: Plain | undefined): ChatMessage[] {
  if (!Array.isArray(messages)) return typeof messages === "string" ? [{ role: "user", content: messages }] : [];
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const msg = m as Record<string, Plain>;
    const role = String(msg.role ?? "user");
    let content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const calls = (msg.tool_calls as Record<string, Plain>[]).map((c) => `${c.name ?? "tool"}(${JSON.stringify(c.arguments ?? {})})`).join(", ");
      content = `${content}${content ? "\n" : ""}[called ${calls}]`;
    }
    if (role === "tool" || role === "function") out.push({ role: "user", content: `[tool result${msg.name ? ` from ${msg.name}` : ""}]\n${content}` });
    else out.push({ role: isSystemRole(role) ? "system" : role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

export class Replays {
  readonly correlation: ReplayCorrelation;
  constructor(private readonly roots: Roots) {
    roots.store.db.exec(SCHEMA);
    const columns = roots.store.db.prepare("PRAGMA table_info(replays)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "attribution")) roots.store.db.exec("ALTER TABLE replays ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unknown'");
    if (!columns.some((c) => c.name === "attribution_reason")) roots.store.db.exec("ALTER TABLE replays ADD COLUMN attribution_reason TEXT NOT NULL DEFAULT 'Replay association predates attribution evidence.'");
    if (!columns.some((c) => c.name === "generated_trace_id")) roots.store.db.exec("ALTER TABLE replays ADD COLUMN generated_trace_id TEXT");
    if (!columns.some((c) => c.name === "output_revoked")) roots.store.db.exec("ALTER TABLE replays ADD COLUMN output_revoked INTEGER NOT NULL DEFAULT 0");
    this.correlation = new ReplayCorrelation(roots.store);
    roots.store.db.prepare("UPDATE replay_windows SET active=0").run();
    roots.store.onRunsDeleted((traces) => {
      const ids = JSON.stringify(traces);
      const affected = roots.store.db.prepare(`SELECT DISTINCT replay_id AS id,trace_id AS previous FROM replay_candidates
        WHERE trace_id IN (SELECT value FROM json_each(?)) UNION
        SELECT id,generated_trace_id AS previous FROM replays WHERE trace_id IN (SELECT value FROM json_each(?))
        OR generated_trace_id IN (SELECT value FROM json_each(?))`).all(ids, ids, ids) as { id: string; previous: string | null }[];
      for (const row of affected) {
        const r = this.get(row.id);
        if (r) roots.bus.emit("replay", { id: r.id, trace_id: r.trace_id, state: r.state, new_trace_id: r.new_trace_id,
          previous_trace_id: row.previous, attribution: r.attribution, attribution_reason: r.attribution_reason });
      }
    });
    // A replay runs in this process (a child command or an HTTP call); it cannot
    // survive a restart. Mark any left in "running" as failed so they don't show
    // "running" forever. (Checks resume after a restart; a replay can't.)
    roots.store.db
      .prepare("UPDATE replays SET state = 'failed', error = ?, finished_ms = ? WHERE state = 'running'")
      .run("interrupted by a restart", Date.now());
  }

  private save(r: Replay, previousTrace?: string | null, quiet = false, generatedTrace: string | null = null): RootsEvents["replay"] {
    const event = this.roots.store.db.transaction(() => {
      this.roots.store.db
        .prepare(
          `INSERT INTO replays (id, trace_id, span_id, kind, via, overrides, state, new_trace_id, output_preview, error, log_tail, created_ms, finished_ms, attribution, attribution_reason, generated_trace_id)
           VALUES (@id, @trace_id, @span_id, @kind, @via, @overrides, @state, @new_trace_id, @output_preview, @error, @log_tail, @created_ms, @finished_ms, @attribution, @attribution_reason, @generatedTrace)
           ON CONFLICT(id) DO UPDATE SET state = excluded.state, new_trace_id = CASE WHEN replays.output_revoked=1 THEN NULL ELSE excluded.new_trace_id END, output_preview = CASE WHEN replays.output_revoked=1 THEN NULL ELSE excluded.output_preview END,
             error = excluded.error, log_tail = excluded.log_tail, finished_ms = excluded.finished_ms,
             attribution=CASE WHEN replays.output_revoked=1 THEN 'unknown' ELSE excluded.attribution END,
             attribution_reason=CASE WHEN replays.output_revoked=1 THEN 'The source or generated run was deleted; reused trace IDs cannot restore its result.' ELSE excluded.attribution_reason END,
             generated_trace_id=COALESCE(excluded.generated_trace_id,replays.generated_trace_id)`,
        )
        .run({ ...r, overrides: JSON.stringify(r.overrides), generatedTrace });
      // Read back inside the writer transaction so callers/events use the guarded value.
      Object.assign(r, this.get(r.id));
      return { id: r.id, state: r.state, trace_id: r.trace_id, new_trace_id: r.new_trace_id,
        previous_trace_id: previousTrace, error: r.error, attribution: r.attribution, attribution_reason: r.attribution_reason };
    })();
    if (!quiet) this.roots.bus.emit("replay", event);
    return event;
  }

  private parse(row: Row): Replay {
    const { generated_trace_id: _generated, output_revoked: _revoked, ...visible } = row;
    return { ...visible, overrides: JSON.parse(row.overrides) as ReplayOverrides };
  }

  /** Replays made from this run, newest first. */
  forRun(traceId: string): Replay[] {
    return (this.roots.store.db.prepare("SELECT * FROM replays WHERE trace_id = ? ORDER BY created_ms DESC LIMIT 50").all(traceId) as Row[]).map((r) => this.parse(r));
  }

  /** The replay that produced this run, if it is one. */
  originOf(traceId: string): Replay | undefined {
    const row = this.roots.store.db.prepare("SELECT * FROM replays WHERE new_trace_id = ?").get(traceId) as Row | undefined;
    return row ? this.parse(row) : undefined;
  }

  get(id: string): Replay | undefined {
    const row = this.roots.store.db.prepare("SELECT * FROM replays WHERE id = ?").get(id) as Row | undefined;
    return row ? this.parse(row) : undefined;
  }

  /** Raw request evidence survives span replacement; completed associations remain revocable. */
  observe(batches: ResourceSpansBatch[], updates: TraceUpdate[]): RootsEvents["replay"][] {
    const events: RootsEvents["replay"][] = [];
    const ids = this.correlation.observe(batches, updates);
    for (const id of ids) {
      const r = this.get(id);
      if (!r || r.state === "running" || (!r.new_trace_id && r.attribution === "unknown")) continue;
      const association = this.correlation.select(id, r.attribution === "fallback-unverified");
      if (r.new_trace_id === association.trace && r.attribution === association.attribution && r.attribution_reason === association.reason) continue;
      const owned = this.roots.store.db.prepare("SELECT generated_trace_id FROM replays WHERE id=?").get(id) as { generated_trace_id: string | null };
      events.push(this.save({ ...r, new_trace_id: association.trace, attribution: association.attribution,
        attribution_reason: association.reason, output_preview: owned.generated_trace_id ? r.output_preview : association.trace ? this.roots.store.getRun(association.trace)?.output_preview ?? null : null }, r.new_trace_id, true));
    }
    return events;
  }

  /** How this project's agent can be re-run: a command, an HTTP endpoint, or neither. */
  target(project: string | null | undefined): { command?: string; cwd?: string; url?: string } | undefined {
    return project ? this.roots.config.rerun[project] : undefined;
  }

  private create(traceId: string, spanId: string | null, kind: Replay["kind"], via: Replay["via"], overrides: ReplayOverrides): Replay {
    const r: Replay = {
      id: `rp_${crypto.randomBytes(6).toString("hex")}`,
      trace_id: traceId,
      span_id: spanId,
      kind,
      via,
      overrides,
      state: "running",
      new_trace_id: null,
      attribution: "unknown",
      attribution_reason: "Waiting for replay attribution evidence.",
      output_preview: null,
      error: null,
      log_tail: null,
      created_ms: Date.now(),
      finished_ms: null,
    };
    const previousTraces = new Map<string, string | null>();
    const evictions = this.correlation.open(r.id, this.roots.store.getRun(traceId)?.project ?? null, previousTraces);
    try { this.save(r); } catch (err) { this.correlation.close(r.id); throw err; }
    for (const id of evictions) {
      const evicted = this.get(id);
      if (evicted) this.roots.bus.emit("replay", { id, state: evicted.state, trace_id: evicted.trace_id, new_trace_id: null,
        previous_trace_id: previousTraces.get(id), attribution: evicted.attribution, attribution_reason: evicted.attribution_reason });
    }
    return r;
  }

  private finish(r: Replay, patch: Partial<Replay>, generatedTrace: string | null = null): Replay {
    this.correlation.close(r.id);
    if (patch.state === "failed" && patch.attribution === undefined)
      patch = { ...patch, attribution: "unknown", attribution_reason: "Replay execution failed; no run association is certified." };
    Object.assign(r, patch, { finished_ms: Date.now() });
    this.save(r, undefined, false, generatedTrace);
    return r;
  }

  /** Re-sends one LLM span's messages (or edited ones) and stores the answer as a new run. */
  async replayLlm(traceId: string, spanId: string, overrides: ReplayOverrides = {}): Promise<Replay> {
    const t = loadTrace(this.roots.store, traceId);
    const span = t.spans.find((s) => s.id === spanId || s.id.startsWith(spanId));
    if (!span) throw new Error("span not found");
    if (span.kind !== "LLM") throw new Error("only LLM spans can be replayed on their own; replay the whole run instead");
    const messages: ChatMessage[] = overrides.messages?.length ? toChat(overrides.messages as Plain) : toChat(span.input);
    if (overrides.edit) {
      const { from, to } = overrides.edit;
      const i = messages.findIndex((m) => m.content === from) >= 0 ? messages.findIndex((m) => m.content === from) : messages.findIndex((m) => m.content.trim() === from.trim());
      if (i < 0) throw new Error("that message isn't in this LLM call");
      messages[i] = { ...messages[i], content: to };
      // Later turns followed from the old message; the fork ends at the edited one.
      messages.splice(i + 1);
    }
    if (overrides.system) {
      const i = messages.findIndex((m) => m.role === "system");
      if (i >= 0) messages[i] = { role: "system", content: overrides.system };
      else messages.unshift({ role: "system", content: overrides.system });
    }
    if (!messages.length) throw new Error("this LLM span has no recorded messages to replay");
    const { edit: _edit, ...rest } = overrides;
    const r = this.create(traceId, span.id, "llm", "llm", { ...rest, messages: messages.map((m) => ({ role: m.role, content: m.content })) });
    try {
      const startMs = Date.now();
      const res = await this.roots.llm.chat(messages, { model: overrides.model, maxTokens: 2048, temperature: 0.2, priority: "high", timeoutSec: 180 });
      const endMs = Date.now();
      const newTrace = crypto.randomBytes(16).toString("hex");
      const output = [{ role: "assistant", content: res.text }];
      const replayAttrs = { "neatroots.replay.id": r.id, "neatroots.replay.of_trace": traceId, "neatroots.replay.of_span": span.id };
      const nodes: SpanNode[] = [
        { traceId: newTrace, spanId: `${newTrace}:root`, name: `replay: ${span.name}`, kind: "workflow", start: startMs, end: endMs, input: messages.filter((m) => m.role === "user").at(-1)?.content, output: res.text, attributes: replayAttrs },
        {
          traceId: newTrace,
          spanId: `${newTrace}:llm`,
          parentSpanId: `${newTrace}:root`,
          name: span.name,
          kind: "llm",
          start: startMs,
          end: endMs,
          input: messages,
          output,
          model: res.model,
          provider: res.where ?? null,
          promptTokens: res.usage?.prompt_tokens ?? null,
          completionTokens: res.usage?.completion_tokens ?? null,
          attributes: replayAttrs,
        },
      ];
      // Register ownership before synchronous postcommit trace observers can delete/reuse it.
      this.roots.store.db.prepare("UPDATE replays SET generated_trace_id=? WHERE id=?").run(newTrace, r.id);
      this.roots.ingest(toBatches(nodes, { project: t.run?.project ?? "replay", source: "replay" }));
      const association = this.correlation.select(r.id);
      return this.finish(r, { state: "succeeded", new_trace_id: association.trace, attribution: association.attribution,
        attribution_reason: association.reason, output_preview: this.roots.store.getRun(traceId) && this.roots.store.getRun(newTrace) ? preview(res.text, 400) : null }, newTrace);
    } catch (err) {
      return this.finish(r, { state: "failed", error: (err as Error).message });
    }
  }

  /** Re-runs the whole agent with overrides. Returns at once; the replay finishes in the background. */
  startRun(traceId: string, overrides: ReplayOverrides = {}): { replay: Replay; done: Promise<Replay> } {
    const t = loadTrace(this.roots.store, traceId);
    if (!t.run) throw new Error("run not found");
    const project = t.run.project;
    const target = this.target(project);
    if (!target?.command && !target?.url) {
      throw new Error(`no way to re-run ${project ?? "this agent"} yet. Register one: neatroots rerun add ${project ?? "<project>"} "<command>" (or --url for an HTTP replay endpoint)`);
    }
    const input = overrides.input ?? runGoal(t).user ?? runGoal(t).rootInput ?? "";
    const r = this.create(traceId, null, "run", target.url ? "http" : "command", { ...overrides, input });
    const done = this.runAgent(r, project ?? "", target, input, overrides).catch((err) => this.finish(r, { state: "failed", error: (err as Error).message }));
    return { replay: r, done };
  }

  private async runAgent(r: Replay, project: string, target: { command?: string; cwd?: string; url?: string }, input: string, o: ReplayOverrides): Promise<Replay> {
    try {
      let tail = "";
      if (target.url) {
        const res = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ replay_id: r.id, replay_of: r.trace_id, input, model: o.model ?? null, system_prompt: o.system ?? null }),
          signal: AbortSignal.timeout(15 * 60_000),
        });
        tail = (await res.text()).slice(-3000);
        if (!res.ok) throw new Error(`replay endpoint answered ${res.status}: ${tail.slice(0, 300)}`);
      } else {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NEATLOGS_ENDPOINT: `http://localhost:${this.roots.config.port}`,
          NEATLOGS_API_KEY: process.env.NEATLOGS_API_KEY ?? "neatroots-local",
          NEATROOTS_REPLAY_ID: r.id,
          NEATROOTS_REPLAY_OF: r.trace_id,
          NEATROOTS_REPLAY_INPUT: input,
          OTEL_RESOURCE_ATTRIBUTES: [process.env.OTEL_RESOURCE_ATTRIBUTES, `neatroots.replay.id=${r.id}`, `neatroots.replay.of=${r.trace_id}`].filter(Boolean).join(","),
        };
        if (o.model) env.NEATROOTS_REPLAY_MODEL = o.model;
        if (o.system) env.NEATROOTS_REPLAY_SYSTEM_PROMPT = o.system;
        const { code, error } = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
          const child = spawn(target.command!, { shell: true, cwd: target.cwd, env });
          const keep = (b: Buffer) => {
            tail = (tail + b.toString()).slice(-6000);
          };
          child.stdout.on("data", keep);
          child.stderr.on("data", keep);
          const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
          child.on("close", (c) => {
            clearTimeout(timer);
            resolve({ code: c });
          });
          // A command that can't start (its folder was deleted, say) emits "error" instead of "close";
          // unhandled, that event would stop the whole neatroots process.
          child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: null, error: e });
          });
        });
        if (error) {
          throw new Error(
            target.cwd && !fs.existsSync(target.cwd)
              ? `the rerun folder ${target.cwd} doesn't exist. Register it again: neatroots rerun add ${project} "<command>" --cwd <dir>`
              : `couldn't start the rerun command: ${error.message}`,
          );
        }
        if (code !== 0) log.info(`replay ${r.id}: the agent exited with ${code}`);
      }
      // Retain the compatibility fallback only after the entire SDK flush window.
      let association = this.correlation.select(r.id);
      for (let i = 0; i < 20 && !association.trace; i++) {
        await new Promise((res) => setTimeout(res, 500));
        association = this.correlation.select(r.id);
      }
      if (!association.trace) association = this.correlation.select(r.id, true);
      const attribution = { attribution: association.attribution, attribution_reason: association.reason };
      if (!association.trace) return this.finish(r, { state: "failed", ...attribution,
        error: "the agent ran, but no uniquely attributable new run reached neatroots. " + association.reason, log_tail: tail || null });
      const run = this.roots.store.getRun(association.trace);
      return this.finish(r, { state: "succeeded", new_trace_id: association.trace, ...attribution,
        output_preview: run?.output_preview ?? null, log_tail: tail || null });
    } finally {
      this.correlation.close(r.id);
    }
  }
}
