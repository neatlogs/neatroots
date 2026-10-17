import { z } from "zod";
import { checkWarnings } from "../checks/lint.js";
import type { Roots } from "../core.js";
import { runDetail, runSummary, spanDetail, checkFromInput } from "../server/api.js";
import { draftCheckFromConcern, askRuns } from "../engine/assist.js";
import { checkToYaml, checkDirState } from "../checks/registry.js";
import { newId } from "../util/ids.js";
import type { Plain } from "../otlp/types.js";

/**
 * Tools for coding agents. Reads need no model. explain_run and ask use the local LLM and
 * are checked by the decision model; judge uses the decision model alone. The local LLM does
 * the heavy reading so the coding agent spends fewer tokens.
 */

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  run: (roots: Roots, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

export function def<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

export function clip(s: string | null | undefined, n: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** The run an id names, else the run in focus, else the latest run. May clear roots.focus (see resolveTraceNoting). */
export function resolveTrace(roots: Roots, id: string | undefined): string {
  return resolveTraceNoting(roots, id).traceId;
}

/**
 * Like resolveTrace, but also says when the run in focus was deleted and the latest run is used
 * instead, so tools can tell the agent. Note: this clears roots.focus when it points at a deleted
 * run, even when called from a read-only tool.
 */
export function resolveTraceNoting(roots: Roots, id: string | undefined): { traceId: string; fellBackFrom?: string } {
  if (id) {
    const exact = roots.store.getRun(id);
    if (exact) return { traceId: exact.trace_id };
    // Match as a literal prefix: % and _ in the id are not wildcards.
    const prefix = id.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = roots.store.db
      .prepare("SELECT trace_id FROM runs WHERE trace_id LIKE ? ESCAPE '\\' ORDER BY started_ms DESC LIMIT 6")
      .all(`${prefix}%`) as { trace_id: string }[];
    if (rows.length === 1) return { traceId: rows[0].trace_id };
    if (rows.length > 1) throw new Error(`run id ${id} matches more than one run (${shortList(rows.map((r) => r.trace_id))}); use more characters`);
    throw new Error(`no run with id ${id}`);
  }
  let fellBackFrom: string | undefined;
  if (roots.focus) {
    // The run in focus may have been deleted since (by the user or by retention); then nothing is in focus.
    if (roots.store.getRun(roots.focus.trace_id)) return { traceId: roots.focus.trace_id };
    fellBackFrom = roots.focus.trace_id;
    roots.focus = null;
  }
  const latest = roots.store.listRuns({ limit: 1 })[0];
  if (!latest) throw new Error(`neatroots has no runs yet. Point NEATLOGS_ENDPOINT at http://localhost:${roots.config.port} and run your agent.`);
  return fellBackFrom ? { traceId: latest.trace_id, fellBackFrom } : { traceId: latest.trace_id };
}

/** The note tools add to their response when resolveTraceNoting fell back to the latest run. */
export function fallbackNote(r: { fellBackFrom?: string }): { note?: string } {
  return r.fellBackFrom ? { note: `The run in focus (${r.fellBackFrom.slice(0, 8)}…) was deleted; using the latest run.` } : {};
}

export function resolveSpan(roots: Roots, traceId: string, spanId: string): string {
  if (!spanId) throw new Error(`a span id is required for run ${traceId}`);
  const spans = roots.store.getSpans(traceId, true);
  const exact = spans.find((s) => s.span_id === spanId);
  if (exact) return exact.span_id;
  const hits = spans.filter((s) => s.span_id.startsWith(spanId.toLowerCase()));
  if (hits.length === 1) return hits[0].span_id;
  if (hits.length > 1) throw new Error(`span id ${spanId} matches more than one span in run ${traceId} (${shortList(hits.map((s) => s.span_id))}); use more characters`);
  throw new Error(`no span ${spanId} in run ${traceId}`);
}

/** Up to five ids, shortened, for an "ambiguous id" message. */
function shortList(ids: string[]): string {
  const shown = ids.slice(0, 5).map((x) => x.slice(0, 12));
  return ids.length > 5 ? `${shown.join(", ")}, …` : shown.join(", ");
}

/** A small JSONPath subset: $, .key, ['key'], [index], [*]. */
export function jsonPath(value: unknown, path: string): unknown {
  if (!path || path === "$") return value;
  const tokens: (string | number | "*")[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]|\[\*\]|\.\*/g;
  const body = path.startsWith("$") ? path.slice(1) : path.startsWith(".") || path.startsWith("[") ? path : `.${path}`;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    if (m.index !== consumed) throw new Error(`unsupported JSONPath near "${body.slice(consumed)}"`);
    consumed = re.lastIndex;
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3]);
    else if (m[4] !== undefined) tokens.push(m[4]);
    else tokens.push("*");
  }
  if (consumed !== body.length) throw new Error(`unsupported JSONPath near "${body.slice(consumed)}"`);
  let cur: unknown[] = [value];
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object") continue;
      if (t === "*") next.push(...(Array.isArray(v) ? v : Object.values(v)));
      else if (typeof t === "number" && Array.isArray(v)) next.push(v[t]);
      else if (typeof t === "string" && !Array.isArray(v)) next.push((v as Record<string, unknown>)[t]);
    }
    cur = next.filter((x) => x !== undefined);
  }
  return tokens.includes("*") ? cur : cur[0];
}

function outline(roots: Roots, traceId: string, maxSpans: number) {
  const d = runDetail(roots, traceId)!;
  const findingsBySpan = new Map<string, string[]>();
  for (const f of d.findings) {
    if (f.status === "dismissed" || f.status === "quiet") continue;
    for (const sid of f.evidence_span_ids) {
      const list = findingsBySpan.get(sid) ?? [];
      list.push(`${f.check_id}${f.probability !== null ? ` p=${f.probability.toFixed(2)}` : ""} [${f.status}]`);
      findingsBySpan.set(sid, list);
    }
  }
  const children = new Map<string | null, typeof d.spans>();
  const ids = new Set(d.spans.map((s) => s.span_id));
  for (const s of d.spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null;
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }
  const lines: string[] = [];
  let count = 0;
  // Parent links can loop; each span is listed once, and spans no root reaches are listed after.
  const listed = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (listed.has(s.span_id)) continue;
      listed.add(s.span_id);
      if (count++ >= maxSpans) return;
      const bits = [
        `${"  ".repeat(depth)}${s.span_id.slice(0, 8)} ${s.span_kind} ${s.tool_name ?? s.name}`,
        s.status_code === 2 ? `ERROR(${clip(s.error, 80)})` : s.status_code === 1 ? "ok" : "",
        s.tool_result && s.tool_result !== "success" ? `result=${s.tool_result}` : "",
        s.total_tokens ? `${s.total_tokens}tok` : "",
        `${Math.round(s.duration_ms)}ms`,
      ].filter(Boolean);
      lines.push(bits.join(" "));
      if (s.input_preview) lines.push(`${"  ".repeat(depth + 1)}in: ${clip(s.input_preview.replace(/\n/g, " ⏎ "), 160)}`);
      if (s.output_preview) lines.push(`${"  ".repeat(depth + 1)}out: ${clip(s.output_preview.replace(/\n/g, " ⏎ "), 160)}`);
      for (const f of findingsBySpan.get(s.span_id) ?? []) lines.push(`${"  ".repeat(depth + 1)}⚑ ${f}`);
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
  for (const s of d.spans) if (!listed.has(s.span_id)) walk(s.parent_span_id, 0);
  return {
    run: {
      trace_id: d.run.trace_id,
      workflow: d.run.workflow,
      status: d.run.status,
      session_id: d.run.session_id,
      started: d.run.started_ms ? new Date(d.run.started_ms).toISOString() : null,
      duration_ms: d.run.duration_ms,
      llm_calls: d.run.llm_calls,
      tool_calls: d.run.tool_calls,
      total_tokens: d.run.total_tokens,
      summary: d.summary?.text ?? null,
    },
    outline: lines.join("\n") + (count > maxSpans ? `\n… ${d.spans.length - maxSpans} more spans (raise max_spans)` : ""),
    findings: d.findings
      .filter((f) => f.status !== "dismissed" && f.status !== "quiet")
      .map((f) => ({ id: f.id, check: f.check_id, title: f.title, status: f.status, probability: f.probability, group: f.detail.group ?? null, evidence_span_ids: f.evidence_span_ids.map((x) => x.slice(0, 8)) })),
    notes_sent: d.notes.filter((n) => n.status === "delivered").map((n) => ({ text: n.text, kind: n.kind })),
  };
}

export const TOOLS = [
  def({
    name: "get_current_run",
    title: "Current run",
    description: "The run in focus in the neatroots app (or the latest run), with its outline, findings and the selected span.",
    input: { max_spans: z.number().int().min(1).max(500).optional().describe("Most spans to include in the outline (default 80)") },
    readOnly: true,
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, undefined);
      const traceId = r.traceId;
      const o = outline(roots, traceId, a.max_spans ?? 80);
      const span = roots.focus?.trace_id === traceId && roots.focus.span_id ? spanDetail(roots, traceId, roots.focus.span_id) : null;
      return { ...o, selected_span: span ? { span_id: span.span_id, name: span.name, kind: span.kind, input: span.view.input, output: span.view.output, error: span.view.error ?? null } : null, ...fallbackNote(r) };
    },
  }),
  def({
    name: "search_runs",
    title: "Search runs",
    description: "Find local agent runs by workflow, status, findings, time or text in span inputs and outputs.",
    input: {
      workflow: z.string().optional(),
      project: z.string().optional(),
      status: z.enum(["running", "ok", "error", "interrupted"]).optional(),
      has_finding: z.boolean().optional(),
      text: z.string().optional().describe("Full-text search over span names, tool names, inputs and outputs"),
      since_minutes: z.number().optional().describe("Only runs that started in the last N minutes"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: async (roots, a) => {
      const runs = roots.store.listRuns({
        workflow: a.workflow,
        project: a.project,
        status: a.status,
        hasFinding: a.has_finding,
        text: a.text,
        sinceMs: a.since_minutes ? Date.now() - a.since_minutes * 60_000 : undefined,
        limit: a.limit ?? 20,
      });
      return {
        runs: runs.map((r) => {
          const s = runSummary(roots, r);
          return {
            trace_id: r.trace_id,
            workflow: r.workflow,
            status: r.status,
            started: r.started_ms ? new Date(r.started_ms).toISOString() : null,
            duration_ms: s.duration_ms,
            spans: r.span_count,
            findings: r.finding_count,
            open_findings: r.open_finding_count,
            input: clip(r.input_preview, 160),
            summary: s.summary,
          };
        }),
      };
    },
  }),
  def({
    name: "get_run_outline",
    title: "Run outline",
    description: "Span tree for one run: kind, status, tokens, duration and input/output previews, with findings inline. Span ids are shortened to 8 characters; any unique prefix works in other tools.",
    input: {
      trace_id: z.string().optional().describe("Run (trace) id or prefix; defaults to the run in focus or the latest run"),
      max_spans: z.number().int().min(1).max(1000).optional(),
    },
    readOnly: true,
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      return { ...outline(roots, r.traceId, a.max_spans ?? 150), ...fallbackNote(r) };
    },
  }),
  def({
    name: "get_span",
    title: "Span detail",
    description: "One span's input, output, error and attributes. Use path (JSONPath subset like $.input[0].content) to select part of it, and offset/limit to page long values.",
    input: {
      trace_id: z.string().optional(),
      span_id: z.string().describe("Span id or unique prefix"),
      path: z.string().optional().describe("JSONPath into {input, output, error, attributes, events, resource}"),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(100).max(50000).optional().describe("Characters to return (default 6000)"),
    },
    readOnly: true,
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const spanId = resolveSpan(roots, traceId, a.span_id);
      const d = spanDetail(roots, traceId, spanId)!;
      const doc = { name: d.name, kind: d.kind, status: d.status, input: d.view.input ?? null, output: d.view.output ?? null, error: d.view.error ?? null, attributes: d.attributes, events: d.events, resource: d.resource };
      const selected = a.path ? jsonPath(doc, a.path) : doc;
      const text = typeof selected === "string" ? selected : JSON.stringify(selected, null, 1);
      const offset = a.offset ?? 0;
      const limit = a.limit ?? 6000;
      return { trace_id: traceId, span_id: spanId, path: a.path ?? "$", total_chars: text.length, offset, value: text.slice(offset, offset + limit), more: offset + limit < text.length, ...fallbackNote(r) };
    },
  }),
  def({
    name: "list_findings",
    title: "List findings",
    description: "Problems neatroots found, with probabilities, evidence span ids and explanations when the local LLM investigated.",
    input: {
      trace_id: z.string().optional().describe("One run; omit for recent findings across runs"),
      status: z.enum(["raised", "active", "resolved", "dismissed", "failed", "quiet"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    run: async (roots, a) => {
      const traceId = a.trace_id ? resolveTrace(roots, a.trace_id) : undefined;
      const findings = roots.store.listFindings({ traceId, status: a.status, limit: a.limit ?? 50 });
      return {
        findings: findings.map((f) => {
          const exp = f.explanation_id ? roots.store.getExplanation(f.explanation_id) : undefined;
          return {
            id: f.id,
            trace_id: f.trace_id,
            check: f.check_id,
            title: f.title,
            status: f.status,
            probability: f.probability,
            triage_score: f.triage_score,
            evidence_span_ids: f.evidence_span_ids,
            explanation: exp ? { cause: exp.cause, fix: exp.fix, grounding: exp.grounding } : null,
            details: f.detail,
          };
        }),
      };
    },
  }),
  def({
    name: "explain_run",
    title: "Explain run",
    description: "The local LLM reads a run and returns the likely cause of a problem, the spans that show it and a suggested fix. The decision model scores how well the evidence supports it (grounding 0–1).",
    input: { trace_id: z.string().optional(), refresh: z.boolean().optional().describe("Ignore a cached explanation") },
    run: async (roots, a) => {
      if (!roots.engine) throw new Error("engine not running");
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const exp = await roots.engine.explainRun(traceId, { force: a.refresh, priority: "interactive" });
      if (!exp) return { trace_id: traceId, explanation: null, reason: "The local LLM could not explain this run.", ...fallbackNote(r) };
      return { trace_id: traceId, cause: exp.cause, fix: exp.fix, evidence_span_ids: exp.evidence_span_ids, grounding: exp.grounding, model: exp.model, ...fallbackNote(r) };
    },
  }),
  def({
    name: "ask",
    title: "Ask about runs",
    description: "Ask a plain-language question over local runs (or one run). The local LLM answers from retrieved spans and cites span ids.",
    input: { question: z.string().min(3), trace_id: z.string().optional() },
    run: async (roots, a) => askRuns(roots, a.question, { traceId: a.trace_id ? resolveTrace(roots, a.trace_id) : undefined }),
  }),
  def({
    name: "judge",
    title: "Judge a question",
    description: "Probability that the answer to a yes/no question is yes, judged by the decision model over chosen spans of a run (or its recent spans).",
    input: {
      question: z.string().min(5),
      trace_id: z.string().optional(),
      span_ids: z.array(z.string()).optional().describe("Spans to judge (ids or prefixes); default is the run's recent spans"),
    },
    run: async (roots, a) => {
      if (!roots.engine) throw new Error("engine not running");
      const resolved = resolveTraceNoting(roots, a.trace_id);
      const traceId = resolved.traceId;
      const r = await roots.engine.judge(traceId, a.question, { spanIds: a.span_ids });
      return { trace_id: traceId, question: a.question, probability_yes: r.probability, evidence_span_ids: r.evidence_span_ids, backend: r.backend, model: r.model, ...fallbackNote(resolved) };
    },
  }),
  def({
    name: "create_check",
    title: "Create check",
    description:
      "Add a check. Give either `concern` (plain language; the local LLM writes the question) or `check` (YAML or JSON in neatroots check format). Set save=false to only draft it. Saved checks go to ~/.neatroots/checks or a registered project directory. Halt rules can't be saved or changed here: save a rule with action: flag, and the user can switch it to halt in the app or CLI.",
    input: {
      concern: z.string().optional(),
      check: z.string().optional().describe("YAML or JSON check definition"),
      workflow: z.string().optional(),
      save: z.boolean().optional(),
      dir: z.string().optional().describe("A registered project checks directory"),
    },
    run: async (roots, a) => {
      let check;
      if (a.check) {
        const text = a.check.trim();
        const parsed = checkFromInput(text.startsWith("{") ? JSON.parse(text) : text);
        if (!parsed.check) throw new Error(parsed.error ?? "invalid check");
        check = parsed.check;
      } else if (a.concern) {
        check = await draftCheckFromConcern(roots, a.concern, { workflow: a.workflow });
      } else throw new Error("give concern or check");
      if (a.save === false) return { saved: false, id: check.id, yaml: checkToYaml(check), warnings: checkWarnings(check) };
      if (a.dir && !roots.config.checkDirs.includes(a.dir)) throw new Error("dir must be a registered project checks directory (neatroots init registers one)");
      if (a.dir) {
        // Save creates a registered directory that isn't there yet; only a path a save can't make is
        // an error here.
        const state = checkDirState(a.dir);
        if (!state.ok && !state.creatable) throw new Error(`that checks directory ${state.reason}`);
      }
      const saved = roots.checks.save(check, a.dir ? { dir: a.dir } : "user", "mcp");
      return { saved: true, id: saved.check.id, path: saved.path, yaml: checkToYaml(saved.check), warnings: checkWarnings(saved.check) };
    },
  }),
  def({
    name: "preview_check",
    title: "Preview check",
    description: "Run a check (by id, YAML or JSON) over recent finished runs without raising findings, and report how often it fires.",
    input: {
      id: z.string().optional(),
      check: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Runs to check (default 50)"),
      workflow: z.string().optional(),
    },
    run: async (roots, a) => {
      if (!roots.engine) throw new Error("engine not running");
      let check;
      if (a.id) check = roots.checks.get(a.id)?.check;
      else if (a.check) {
        const text = a.check.trim();
        check = checkFromInput(text.startsWith("{") ? JSON.parse(text) : text).check;
      }
      if (!check) throw new Error("check not found or invalid");
      const r = await roots.engine.previewCheck(check, { limit: a.limit ?? 50, workflow: a.workflow });
      return { id: check.id, checked: r.checked, total: r.total, hits: r.hits.length, hit_rate: r.checked ? r.hits.length / r.checked : null, truncated: r.truncated, examples: r.hits.slice(0, 10), warnings: checkWarnings(check) };
    },
  }),
  def({
    name: "annotate",
    title: "Annotate",
    description: "Mark a run or span as an issue, good, or add a note.",
    input: {
      trace_id: z.string().optional(),
      span_id: z.string().optional(),
      label: z.enum(["issue", "good", "note"]),
      text: z.string().optional(),
    },
    run: async (roots, a) => {
      const r = resolveTraceNoting(roots, a.trace_id);
      const traceId = r.traceId;
      const spanId = a.span_id ? resolveSpan(roots, traceId, a.span_id) : null;
      const ann = roots.store.insertAnnotation({ trace_id: traceId, span_id: spanId, label: a.label, text: a.text ?? null, author: "coding-agent" });
      roots.bus.emit("activity", { trace_id: traceId, kind: "annotation", message: a.label });
      return { ...ann, ...fallbackNote(r) };
    },
  }),
  def({
    name: "rerun",
    title: "Rerun agent",
    description:
      "Rerun the agent through the command or HTTP replay endpoint registered for its project (neatroots rerun add), optionally with a different input, model or system prompt. Waits for the new run and returns it with its findings, so you can tell whether a fix worked.",
    input: {
      trace_id: z.string().optional().describe("Run to re-run; defaults to the run in focus or the latest"),
      input: z.string().optional().describe("User input to run with instead of the original"),
      model: z.string().optional(),
      system: z.string().optional().describe("System prompt override (applied by the neatroots-steer hook)"),
      timeout_sec: z.number().int().min(5).max(900).optional(),
    },
    run: async (roots, a) => {
      const resolved = resolveTraceNoting(roots, a.trace_id);
      const traceId = resolved.traceId;
      const { replay, done } = roots.replays.startRun(traceId, { input: a.input, model: a.model, system: a.system });
      const r = await Promise.race([done, new Promise<null>((res) => setTimeout(() => res(null), (a.timeout_sec ?? 300) * 1000))]);
      if (!r) return { replay_id: replay.id, state: "running", note: [fallbackNote(resolved).note, "still running; call get_current_run or search_runs later"].filter(Boolean).join(" ") };
      const run = r.new_trace_id ? runSummary(roots, roots.store.getRun(r.new_trace_id)!) : null;
      const findings = r.new_trace_id ? roots.store.listFindings({ traceId: r.new_trace_id }).map((f) => ({ check: f.check_id, title: f.title, status: f.status })) : [];
      return { replay_id: r.id, state: r.state, error: r.error, original: traceId, new_run: run, findings, log_tail: clip(r.log_tail, 2000), ...fallbackNote(resolved) };
    },
  }),
  def({
    name: "push_to_cloud",
    title: "Push to Neatlogs Cloud",
    description: "Ask to send runs to Neatlogs Cloud. Nothing is sent until the user confirms in the neatroots app; call again with push_id to check the result.",
    input: { trace_ids: z.array(z.string()).optional(), push_id: z.string().optional() },
    run: async (roots, a) => {
      if (a.push_id) {
        const p = roots.pushes.get(a.push_id);
        if (!p) throw new Error("unknown push_id");
        return { ...p, app_url: roots.config.cloud.appUrl };
      }
      const fallback = a.trace_ids?.length ? undefined : resolveTraceNoting(roots, undefined);
      const ids = (fallback ? [fallback.traceId] : a.trace_ids!).map((t) => resolveTrace(roots, t));
      const id = newId("push");
      roots.pushes.set(id, { id, trace_ids: ids, requested_by: "coding-agent", created_ms: Date.now(), status: "pending" });
      roots.bus.emit("activity", { kind: "push-request", message: id });
      return { push_id: id, status: "awaiting_confirmation", confirm_in_app: `http://localhost:${roots.config.port}/#/push/${id}`, trace_ids: ids, ...(fallback ? fallbackNote(fallback) : {}) };
    },
  }),
] as ToolDef[];

export function toolResultText(value: unknown): string {
  return JSON.stringify(value as Plain, null, 1);
}
