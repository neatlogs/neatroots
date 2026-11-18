import type { Store } from "../store/db.js";
import { buildView, isSystemRole, preview, type SpanKind } from "../semantics/view.js";
import { hasRemoteParent, type Plain } from "../otlp/types.js";
import type { Evidence, EvidenceField, SpanSelector } from "../checks/types.js";
import type { RunRow, SpanRow } from "../types.js";

export interface SpanInfo {
  id: string;
  /** Short reference used in prompts; the first 6 hex characters of the span id. */
  ref: string;
  parentId: string | null;
  /** OTLP span flags; bit 9 marks a parent in another process. */
  flags?: number;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
  error?: string;
  finishReason?: string;
  toolName?: string;
  model?: string;
  tokens?: number;
  input?: Plain;
  output?: Plain;
  toolCalls?: { id?: string; name: string; arguments: Plain }[];
  tools?: string[];
  seq: number;
}

export interface TraceSnapshot {
  traceId: string;
  run: RunRow | undefined;
  spans: SpanInfo[];
}

function statusOf(row: SpanRow): SpanInfo["status"] {
  return row.status_code === 2 ? "error" : row.status_code === 1 ? "ok" : "unset";
}

/** Parsed spans per trace, reused across loads; a span is re-parsed only when its seq changes. */
const parsed = new WeakMap<Store, Map<string, Map<string, SpanInfo>>>();
const MAX_CACHED_TRACES = 64;

function traceCache(store: Store, traceId: string): Map<string, SpanInfo> {
  let byTrace = parsed.get(store);
  if (!byTrace) {
    byTrace = new Map();
    parsed.set(store, byTrace);
  }
  let spans = byTrace.get(traceId);
  if (spans) {
    // Refresh recency for the LRU.
    byTrace.delete(traceId);
    byTrace.set(traceId, spans);
    return spans;
  }
  spans = new Map();
  byTrace.set(traceId, spans);
  if (byTrace.size > MAX_CACHED_TRACES) byTrace.delete(byTrace.keys().next().value as string);
  return spans;
}

export function loadTrace(store: Store, traceId: string): TraceSnapshot {
  const rows = store.getSpans(traceId, false);
  const cache = traceCache(store, traceId);
  const live = new Set<string>();
  const spans: SpanInfo[] = [];
  for (const row of rows) {
    // neatroots' own guidance records are not part of the agent's behavior.
    if (row.name === "neatroots.guidance" || row.name === "roots.guidance") continue;
    live.add(row.span_id);
    const hit = cache.get(row.span_id);
    if (hit && hit.seq === row.seq) {
      spans.push(hit);
      continue;
    }
    const full = store.getOtlpSpan(traceId, row.span_id);
    if (!full) continue;
    const v = buildView(full.span, full.resource.attributes);
    const info: SpanInfo = {
      id: row.span_id,
      ref: row.span_id.slice(0, 6),
      parentId: row.parent_span_id,
      flags: full.span.flags,
      name: row.name,
      kind: v.kind,
      startMs: row.start_ms,
      endMs: row.end_ms,
      durationMs: row.duration_ms,
      status: statusOf(row),
      error: v.error,
      finishReason: v.finishReason,
      toolName: v.toolName,
      model: v.model,
      tokens: v.totalTokens,
      input: v.input,
      output: v.output,
      toolCalls: v.toolCalls,
      tools: v.tools,
      seq: row.seq,
    };
    cache.set(row.span_id, info);
    spans.push(info);
  }
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  spans.sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  return { traceId, run: store.getRun(traceId), spans };
}

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : [v]).map((x) => x.toLowerCase());
}

export function matchesSelector(s: SpanInfo, sel: SpanSelector | undefined): boolean {
  if (!sel) return true;
  const types = asList(sel.type);
  if (types && !types.includes(s.kind.toLowerCase())) return false;
  const names = asList(sel.name);
  if (names && !names.includes(s.name.toLowerCase()) && !(s.toolName && names.includes(s.toolName.toLowerCase()))) return false;
  const tools = asList(sel.tool);
  if (tools && !(s.toolName && tools.includes(s.toolName.toLowerCase()))) return false;
  if (sel.status && sel.status !== "any") {
    if (sel.status === "ok" ? s.status === "error" : s.status !== sel.status) return false;
  }
  return true;
}

export function selectSpans(spans: SpanInfo[], sel: SpanSelector | undefined): SpanInfo[] {
  return spans.filter((s) => matchesSelector(s, sel));
}

function textOf(v: Plain | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * The run's top span: one with no parent, or, when the trace holds none, one whose parent stayed
 * outside it. A remote-parent span never stands in for a parentless one: when two agents in one
 * trace both export here, context propagation gives the callee's top span a remote parent while the
 * caller's parentless top span is in the same trace, and the run ends on the caller's span, not the
 * callee's (the remote-parent read is for the case where the caller's span never arrives, #157).
 */
export function runRoot(spans: SpanInfo[]): SpanInfo | undefined {
  const top = spans.find((s) => !s.parentId);
  if (top) return top;
  const ids = new Set(spans.map((s) => s.id));
  return spans.find((s) => !!s.parentId && !ids.has(s.parentId) && hasRemoteParent(s));
}

/** The run's goal: its system prompt and first user message, or the root input. */
export function runGoal(t: TraceSnapshot): { system?: string; user?: string; rootInput?: string } {
  const goal: { system?: string; user?: string; rootInput?: string } = {};
  const firstLlm = t.spans.find((s) => s.kind === "LLM" && Array.isArray(s.input));
  if (firstLlm && Array.isArray(firstLlm.input)) {
    for (const m of firstLlm.input as Record<string, Plain>[]) {
      if (!m || typeof m !== "object") continue;
      if (isSystemRole(m.role) && !goal.system) goal.system = textOf(m.content);
      if (m.role === "user" && !goal.user) goal.user = textOf(m.content);
    }
  }
  const root = runRoot(t.spans);
  if (root?.input !== undefined) goal.rootInput = textOf(root.input);
  return goal;
}

function replyText(output: Plain | undefined): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (Array.isArray(output)) {
    const parts = (output as Record<string, Plain>[])
      .map((m) => (m && typeof m === "object" ? textOf(m.content) : textOf(m as Plain)))
      .filter((x): x is string => !!x && x !== "null" && x.trim() !== "");
    return parts.length ? parts.join("\n") : undefined;
  }
  const s = textOf(output);
  return s && s !== "null" && s.trim() !== "" && s !== '""' ? s : undefined;
}

/** The run's final answer: the root output, or the text of the last LLM reply. Undefined when empty. */
export function finalOutput(t: TraceSnapshot): string | undefined {
  const root = runRoot(t.spans);
  const rootOut = textOf(root?.output);
  if (rootOut && rootOut !== '""' && rootOut !== "null") return rootOut;
  const llms = t.spans.filter((s) => s.kind === "LLM" && s.output !== undefined);
  const last = llms[llms.length - 1];
  const text = last ? replyText(last.output) : undefined;
  return text ? (text.length > 4000 ? text.slice(0, 3999) + "…" : text) : undefined;
}

export function toolsOffered(t: TraceSnapshot): string[] {
  const set = new Set<string>();
  for (const s of t.spans) for (const tool of s.tools ?? []) set.add(tool);
  for (const s of t.spans) if (s.toolName) set.add(s.toolName);
  return [...set];
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * An LLM call's input as its latest messages, newest last. The system prompt is left out (the
 * evidence states it once, up front); keeping the head instead would hide what just happened.
 */
export function latestMessages(input: Plain | undefined, max: number): string | undefined {
  if (!Array.isArray(input) || !input.every((m) => m && typeof m === "object" && "role" in (m as object))) return undefined;
  const msgs = (input as Record<string, Plain>[]).filter((m) => !isSystemRole(m.role));
  const lines: string[] = [];
  let size = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = clip(preview([msgs[i]] as Plain, 600).replace(/\s+/g, " "), 600);
    if (size + line.length > max && lines.length > 0) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  const hidden = msgs.length - lines.length;
  return (hidden > 0 ? `(${hidden} earlier message${hidden > 1 ? "s" : ""} not shown) ` : "") + lines.join(" | ");
}

export function describeSpan(s: SpanInfo, fields: EvidenceField[], perField = 700): string {
  const head = `[${s.ref}] ${s.kind}${s.toolName ? ` ${s.toolName}` : ` ${s.name}`}`;
  const parts: string[] = [head];
  if (fields.includes("status")) parts.push(`status=${s.status.toUpperCase()}`);
  if (fields.includes("model") && s.model) parts.push(`model=${s.model}`);
  if (fields.includes("tokens") && s.tokens) parts.push(`tokens=${s.tokens}`);
  if (fields.includes("duration")) parts.push(`${Math.round(s.durationMs)}ms`);
  let line = parts.join(" ");
  if (fields.includes("input") && s.input !== undefined) {
    const latest = s.kind === "LLM" ? latestMessages(s.input, perField) : undefined;
    line += `\n  input: ${latest ?? clip(preview(s.input, perField * 2), perField)}`;
  }
  if (fields.includes("output") && s.output !== undefined) line += `\n  output: ${clip(preview(s.output, perField * 2), perField)}`;
  if ((fields.includes("error") || fields.includes("status")) && s.error) line += `\n  error: ${clip(s.error, 300)}`;
  return line;
}

export interface BuiltEvidence {
  text: string;
  spanIds: string[];
}

/**
 * Renders the spans a question looks at as compact text for a decision model or the LLM.
 * Span content is untrusted, so it is quoted as data and bounded in size.
 */
export function buildEvidence(t: TraceSnapshot, ev: Evidence | undefined, opts: { focus?: SpanInfo; budget?: number } = {}): BuiltEvidence {
  const budget = opts.budget ?? 6000;
  const fields: EvidenceField[] = ev?.fields ?? ["input", "output", "status", "error"];
  const sections: string[] = [];
  if (ev?.goal !== false) {
    const g = runGoal(t);
    const goalLines: string[] = [];
    if (g.system) goalLines.push(`System prompt: ${clip(g.system, 900)}`);
    if (g.user) goalLines.push(`User request: ${clip(g.user, 600)}`);
    else if (g.rootInput) goalLines.push(`Run input: ${clip(g.rootInput, 600)}`);
    if (goalLines.length) sections.push(goalLines.join("\n"));
  }
  // A question about one span still needs what the run did before it: an instruction such as
  // "plan before you search" is only broken if the plan never happened.
  if (opts.focus) sections.push(runSoFar(t, opts.focus));
  let spans = opts.focus ? [opts.focus] : selectSpans(t.spans, ev?.spans);
  if (!opts.focus && ev?.last) spans = spans.slice(-ev.last);
  const used: string[] = [];
  const spanTexts: string[] = [];
  let size = sections.join("\n").length;
  // Newest spans matter most; fill from the end, then restore order.
  for (let i = spans.length - 1; i >= 0; i--) {
    const d = describeSpan(spans[i], fields, opts.focus ? 1600 : 700);
    if (size + d.length > budget && spanTexts.length > 0) break;
    spanTexts.unshift(d);
    used.unshift(spans[i].id);
    size += d.length;
  }
  if (spanTexts.length) sections.push(`Spans (oldest first):\n${spanTexts.join("\n")}`);
  if (ev?.final_output) {
    const out = finalOutput(t);
    if (out) sections.push(`Final answer: ${clip(out, 1500)}`);
  }
  return { text: sections.join("\n\n"), spanIds: used };
}

/** The tool calls that started before a span, oldest first, as one line each. */
export function runSoFar(t: TraceSnapshot, focus: SpanInfo, max = 25): string {
  const earlier = t.spans.filter((s) => (s.kind === "TOOL" || s.kind === "MCP_TOOL") && s.id !== focus.id && s.startMs <= focus.startMs && s.endMs <= focus.startMs);
  if (!earlier.length) return "Tool calls earlier in this run: none.";
  const shown = earlier.slice(-max);
  const lines = shown.map((s) => `- [${s.ref}] ${s.toolName ?? s.name} ${s.status === "error" ? `failed${s.error ? `: ${clip(s.error, 80)}` : ""}` : "ok"}${s.input !== undefined ? ` · ${clip(preview(s.input, 200).replace(/\s+/g, " "), 100)}` : ""}`);
  const more = earlier.length - shown.length;
  return `Tool calls earlier in this run (oldest first${more > 0 ? `; ${more} earlier not shown` : ""}):\n${lines.join("\n")}`;
}

/** Maps short refs or full ids the LLM mentions back to span ids in this trace. */
export function resolveRefs(t: TraceSnapshot, refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const out = new Set<string>();
  for (const r of refs) {
    const s = String(r).replace(/[[\]\s]/g, "").toLowerCase();
    if (!s) continue;
    const hit = t.spans.find((x) => x.id === s || x.ref === s || (s.length >= 4 && x.id.startsWith(s)));
    if (hit) out.add(hit.id);
  }
  return [...out];
}
