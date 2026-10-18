import { z } from "zod";
import type { Roots } from "../core.js";
import { loadTrace, type SpanInfo } from "../engine/trace.js";
import { listCloudTraces, NO_CLOUD_TOKEN } from "../ingest/importers/neatlogs-cloud.js";
import { cloudImportAuth, cloudImportBase } from "../ingest/importers/index.js";
import { preview } from "../semantics/view.js";
import { runSummary } from "../server/api.js";
import { runReadonlySql } from "./sql-runner.js";
import { clip, def, fallbackNote, resolveSpan, resolveTrace, resolveTraceNoting, type ToolDef } from "./tools.js";

// Tools for exploring runs: where a span sits, finding things inside one run, conversations
// across runs, comparing two runs, read-only SQL over the local store, opening something in the
// app, replays, and pulling a trace down from Neatlogs Cloud.

const brief = (s: SpanInfo) => ({
  span_id: s.id,
  name: s.toolName ?? s.name,
  kind: s.kind,
  status: s.status,
  duration_ms: Math.round(s.durationMs),
  ...(s.model ? { model: s.model } : {}),
  ...(s.error ? { error: clip(s.error, 300) } : {}),
});

const SQL_TABLES = "runs, spans, sessions, findings, decisions, explanations, notes, summaries, annotations, logs, checks, plans, replays";

export const EXPLORE_TOOLS = [
  def({
    name: "show_in_ui",
    title: "Show in the neatroots app",
    description: "Open a run (and optionally a span or a view: overview, trace, timeline, conversation) in the neatroots app the user has open, so you can point at what you're talking about.",
    readOnly: true,
    input: { trace_id: z.string().optional(), span_id: z.string().optional(), view: z.enum(["overview", "trace", "timeline", "conversation"]).optional() },
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const spanId = a.span_id ? resolveSpan(roots, traceId, a.span_id) : null;
      const q = new URLSearchParams();
      if (a.view) q.set("view", a.view);
      if (spanId) q.set("span", spanId);
      const path = `runs/${traceId}${q.size ? `?${q}` : ""}`;
      roots.focus = { trace_id: traceId, span_id: spanId, at: Date.now() };
      roots.bus.emit("navigate", { path });
      return { shown: true, url: `http://localhost:${roots.config.port}/#/${path}`, ...fallbackNote(r) };
    },
  }),
  def({
    name: "get_span_context",
    title: "Span context",
    description: "Where a span sits in its run: its ancestors from the root, its siblings in order, and its children, each with kind, status, duration and an input/output preview.",
    readOnly: true,
    input: { trace_id: z.string().optional(), span_id: z.string() },
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const id = resolveSpan(roots, traceId, a.span_id);
      const t = loadTrace(roots.store, traceId);
      const byId = new Map(t.spans.map((s) => [s.id, s]));
      const span = byId.get(id)!;
      const ancestors: SpanInfo[] = [];
      const seen = new Set<string>([id]);
      for (let p = span.parentId ? byId.get(span.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
        seen.add(p.id);
        ancestors.unshift(p);
      }
      const siblings = t.spans.filter((s) => s.parentId === span.parentId).sort((x, y) => x.startMs - y.startMs);
      const children = t.spans.filter((s) => s.parentId === id).sort((x, y) => x.startMs - y.startMs);
      const withIo = (s: SpanInfo) => ({ ...brief(s), input: clip(preview(s.input, 300), 300), output: clip(preview(s.output, 300), 300) });
      return {
        span: withIo(span),
        ancestors: ancestors.map(brief),
        position: `${siblings.findIndex((s) => s.id === id) + 1} of ${siblings.length} under ${span.parentId ? (byId.get(span.parentId)?.name ?? "parent") : "the root"}`,
        previous_sibling: (() => {
          const i = siblings.findIndex((s) => s.id === id);
          return i > 0 ? withIo(siblings[i - 1]) : null;
        })(),
        next_sibling: (() => {
          const i = siblings.findIndex((s) => s.id === id);
          return i >= 0 && i < siblings.length - 1 ? withIo(siblings[i + 1]) : null;
        })(),
        children: children.map(withIo),
        ...fallbackNote(r),
      };
    },
  }),
  def({
    name: "search_in_run",
    title: "Search inside a run",
    description: "Find spans in one run whose name, tool, model, input, output or error contains the text (case-insensitive). Returns matching spans with a snippet around each hit.",
    readOnly: true,
    input: { trace_id: z.string().optional(), query: z.string().min(1), kinds: z.array(z.string()).optional().describe("Only these span kinds, e.g. LLM, TOOL") },
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const q = a.query.toLowerCase();
      const kinds = a.kinds?.map((k) => k.toUpperCase());
      const hits = [];
      for (const s of loadTrace(roots.store, traceId).spans) {
        if (kinds && !kinds.includes(s.kind)) continue;
        const fields: [string, string][] = [
          ["name", `${s.name} ${s.toolName ?? ""} ${s.model ?? ""}`],
          ["input", preview(s.input, 100_000)],
          ["output", preview(s.output, 100_000)],
          ["error", s.error ?? ""],
        ];
        for (const [field, text] of fields) {
          const i = text.toLowerCase().indexOf(q);
          if (i < 0) continue;
          hits.push({ ...brief(s), field, snippet: `${i > 60 ? "…" : ""}${text.slice(Math.max(0, i - 60), i + q.length + 60)}${i + q.length + 60 < text.length ? "…" : ""}` });
          break;
        }
        if (hits.length >= 50) break;
      }
      return { trace_id: traceId, query: a.query, matches: hits.length, spans: hits, ...fallbackNote(r) };
    },
  }),
  def({
    name: "get_conversation",
    title: "Conversation",
    description: "All runs in one session (a multi-turn conversation), oldest first, with each turn's input, output, status and open problems. Defaults to the session of the run in focus.",
    readOnly: true,
    input: { session_id: z.string().optional(), trace_id: z.string().optional() },
    run: async (roots, a) => {
      // A run is only looked up without a session id; then the agent hears if the run in focus was deleted.
      const resolved = a.session_id ? undefined : resolveTraceNoting(roots, a.trace_id);
      const fellBack = resolved ? fallbackNote(resolved) : {};
      const session = a.session_id ?? roots.store.getRun(resolved!.traceId)?.session_id;
      if (!session) {
        const why = "This run has no session id. Agents set one with neatlogs.init(session_id=…) or the neatlogs.session.id attribute.";
        return { session_id: null, note: [fellBack.note, why].filter(Boolean).join(" ") };
      }
      const runs = roots.store.listRuns({ sessionId: session, limit: 200 }).sort((x, y) => (x.started_ms ?? 0) - (y.started_ms ?? 0));
      return {
        session_id: session,
        turns: runs.map((r, i) => ({ turn: i + 1, trace_id: r.trace_id, status: r.status, input: clip(r.input_preview, 600), output: clip(r.output_preview, 600), open_problems: r.open_finding_count })),
        ...fellBack,
      };
    },
  }),
  def({
    name: "compare_runs",
    title: "Compare two runs",
    description: "Side by side: status, duration, tokens, LLM and tool calls, the sequence of tools each called, final outputs, and which problems each has. Use it after a fix or a replay.",
    readOnly: true,
    input: { a: z.string(), b: z.string() },
    run: async (roots, args) => {
      const one = (id: string) => {
        const traceId = resolveTrace(roots, id);
        const t = loadTrace(roots.store, traceId);
        const run = t.run!;
        return {
          summary: runSummary(roots, run),
          tools: t.spans.filter((s) => s.kind === "TOOL" || s.kind === "MCP_TOOL").sort((x, y) => x.startMs - y.startMs).map((s) => `${s.toolName ?? s.name}${s.status === "error" ? " (failed)" : ""}`),
          output: clip(run.output_preview, 1200),
          problems: roots.store.listFindings({ traceId }).filter((f) => f.status === "raised" || f.status === "active").map((f) => f.title),
        };
      };
      const x = one(args.a);
      const y = one(args.b);
      return {
        a: x,
        b: y,
        fixed: x.problems.filter((p) => !y.problems.includes(p)),
        new_problems: y.problems.filter((p) => !x.problems.includes(p)),
        same_tool_sequence: JSON.stringify(x.tools) === JSON.stringify(y.tools),
      };
    },
  }),
  def({
    name: "list_projects",
    title: "Projects",
    description: "The projects (agents) neatroots has seen, with run counts, how many had problems, and when each last ran.",
    readOnly: true,
    input: {},
    run: async (roots) =>
      roots.store.db
        // Runs store ok/error/interrupted, so count the two statuses the app shows as failed.
        .prepare("SELECT project, COUNT(*) AS runs, SUM(open_finding_count > 0) AS with_problems, SUM(status IN ('error', 'interrupted')) AS failed, MAX(started_ms) AS last_ms FROM runs WHERE doctor = 0 GROUP BY project ORDER BY last_ms DESC")
        .all(),
  }),
  def({
    name: "query_sql",
    title: "Read-only SQL",
    description: `Run one read-only SQLite SELECT over the local store (tables: ${SQL_TABLES}). Times are ms since the epoch. Use it for questions the other tools don't answer, e.g. "which tool failed most this week". At most 200 rows come back; truncated is true when there were more. A query that runs longer than 5 s is stopped with an error.`,
    readOnly: true,
    input: { sql: z.string().min(1) },
    run: async (roots, a) => {
      const sql = a.sql.trim().replace(/;+\s*$/, "");
      if (!/^(select|with)\b/i.test(sql) || /;/.test(sql)) throw new Error("only a single SELECT (or WITH … SELECT) statement is allowed");
      // Runs in a child process with a time limit: an aggregate or ORDER BY over an unbounded
      // recursive CTE computes everything before its first row, so a row cap alone can't stop it.
      return runReadonlySql(roots.store.file, sql);
    },
  }),
  def({
    name: "replay",
    title: "Replay",
    description:
      "Fork a run: re-send one LLM span's messages (edited if you pass messages, or with another model or system prompt) to the user's configured LLM, without running the agent. Stores the answer as a new run and returns it. For a whole-agent re-run use rerun.",
    input: {
      trace_id: z.string().optional(),
      span_id: z.string().describe("The LLM span to replay"),
      messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
      model: z.string().optional(),
      system: z.string().optional(),
    },
    run: async (roots, a) => {
      const resolved = resolveTraceNoting(roots, a.trace_id);
      const traceId = resolved.traceId;
      const r = await roots.replays.replayLlm(traceId, resolveSpan(roots, traceId, a.span_id), { messages: a.messages, model: a.model, system: a.system });
      return { replay_id: r.id, state: r.state, error: r.error, new_trace_id: r.new_trace_id, answer: r.output_preview, ...fallbackNote(resolved) };
    },
  }),
  def({
    name: "list_cloud_traces",
    title: "Neatlogs Cloud traces",
    description: "Recent traces in the user's Neatlogs Cloud project (needs a Neatlogs service-account token stored in neatroots). Import one with import_cloud_trace to debug it locally.",
    readOnly: true,
    input: { limit: z.number().int().min(1).max(50).optional(), workflow: z.string().optional() },
    run: async (roots, a) => {
      const auth = await cloudImportAuth(roots);
      if (!auth) throw new Error(NO_CLOUD_TOKEN);
      const page = await listCloudTraces(cloudImportBase(roots), auth, { limit: a.limit ?? 20, workflowName: a.workflow });
      return page.traces;
    },
  }),
  def({
    name: "import_cloud_trace",
    title: "Import from Neatlogs Cloud",
    description: "Pull one trace (production, say) from Neatlogs Cloud into neatroots, with its inputs and outputs, so you can explain it, check it and replay it locally.",
    input: { trace_id: z.string() },
    run: async (roots, a) => {
      const { done } = roots.imports.start("neatlogs-cloud", { traceIds: a.trace_id }, { limit: 1 });
      const job = await done;
      if (job.state !== "succeeded" || !job.trace_ids.length) throw new Error(job.last_error ?? "the trace was not imported");
      const run = roots.store.getRun(job.trace_ids[0]);
      return { imported: true, trace_id: job.trace_ids[0], run: run ? runSummary(roots, run) : null };
    },
  }),
] as ToolDef[];
