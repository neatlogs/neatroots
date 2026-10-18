import type { SpanInfo, TraceSnapshot } from "../engine/trace.js";
import type { Plain } from "../otlp/types.js";
import { isSystemRole, preview } from "./view.js";

// A run read as a conversation: what the user asked, what the model said and which tools it
// called, in order. Built from LLM spans (their messages), tool spans, and agent spans, which
// become cards you can open as their own conversation (sub-agents).

export type ChatItem =
  | { type: "system"; text: string; span_id: string }
  /** history: an earlier turn, replayed in this call's input (not something that happened in this run). */
  | { type: "user"; text: string; span_id: string; history?: boolean }
  /** inferred: the SDK recorded no tool call; it was read from the tool spans that ran next. */
  | { type: "assistant"; text: string; span_id: string; model?: string; tokens?: number; tool_calls: { name: string; arguments: Plain }[]; error?: string; history?: boolean; inferred?: boolean }
  | { type: "tool"; name: string; span_id: string; input: Plain | undefined; output: Plain | undefined; status: SpanInfo["status"]; error?: string; duration_ms: number }
  | { type: "agent"; name: string; span_id: string; status: SpanInfo["status"]; duration_ms: number; llm_calls: number; tool_calls: number; input?: string; output?: string; error?: string };

function text(v: Plain | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v === "null" ? "" : v;
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === "object" && !Array.isArray(p) ? text((p as Record<string, Plain>).text ?? (p as Record<string, Plain>).content) : text(p))).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, Plain>;
    if (typeof o.content === "string") return o.content;
    if (typeof o.text === "string") return o.text;
  }
  return JSON.stringify(v);
}

function messages(v: Plain | undefined): Record<string, Plain>[] {
  if (Array.isArray(v)) return v.filter((m): m is Record<string, Plain> => !!m && typeof m === "object" && !Array.isArray(m) && "role" in m);
  return [];
}

/**
 * The conversation under one span (the root, or a sub-agent). Spans inside a nested agent are
 * folded into that agent's card.
 */
export function buildChat(t: TraceSnapshot, rootSpanId?: string): { root: string | null; items: ChatItem[] } {
  const spans = [...t.spans].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const children = new Map<string, SpanInfo[]>();
  for (const s of spans) if (s.parentId) children.set(s.parentId, [...(children.get(s.parentId) ?? []), s]);
  const root = rootSpanId ? byId.get(rootSpanId) : (spans.find((s) => !s.parentId || !byId.has(s.parentId)) ?? spans[0]);
  if (!root) return { root: null, items: [] };

  // Walk the subtree in time order, stopping at nested agents. Parent links come from outside and
  // can loop (A's parent is B, B's is A), so each span is visited once.
  const inScope: SpanInfo[] = [];
  const visited = new Set<string>([root.id]);
  const walk = (s: SpanInfo) => {
    for (const c of children.get(s.id) ?? []) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      inScope.push(c);
      if (c.kind === "AGENT" && c.id !== root.id) continue;
      walk(c);
    }
  };
  walk(root);
  inScope.sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  const hasTools = inScope.some((s) => s.kind === "TOOL" || s.kind === "MCP_TOOL");
  const count = (s: SpanInfo, kind: string, seen = new Set<string>([s.id])): number =>
    (children.get(s.id) ?? []).reduce((n, c) => (seen.has(c.id) ? n : (seen.add(c.id), n + (c.kind === kind ? 1 : 0) + count(c, kind, seen))), 0);

  const items: ChatItem[] = [];
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  let llmCalls = 0;
  for (const s of inScope) {
    if (s.kind === "LLM") {
      llmCalls++;
      const msgs = messages(s.input);
      // Messages before the last user message are the conversation so far (earlier turns).
      const current = msgs.map((m) => String(m.role)).lastIndexOf("user");
      msgs.forEach((m, i) => {
        const role = String(m.role);
        const body = text(m.content);
        const history = i < current;
        if (isSystemRole(role) && body && once(`system:${body}`)) items.push({ type: "system", text: body, span_id: s.id });
        else if (role === "user" && body && once(`user:${body}`)) items.push({ type: "user", text: body, span_id: s.id, ...(history ? { history } : {}) });
        else if (role === "assistant" && history && body && once(`assistant:${body}`)) items.push({ type: "assistant", text: body, span_id: s.id, tool_calls: [], history });
        else if ((role === "tool" || role === "function") && !hasTools && body && once(`tool:${body}`))
          items.push({ type: "tool", name: String(m.name ?? "tool"), span_id: s.id, input: undefined, output: body, status: "ok", duration_ms: 0 });
      });
      if (typeof s.input === "string" && s.input && once(`user:${s.input}`)) items.push({ type: "user", text: s.input, span_id: s.id });
      const out = messages(s.output);
      const reply = out.length ? out.map((m) => text(m.content)).filter(Boolean).join("\n") : text(s.output);
      const calls = s.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })) ?? out.flatMap((m) => (Array.isArray(m.tool_calls) ? (m.tool_calls as Record<string, Plain>[]).map((c) => ({ name: String(c.name ?? "tool"), arguments: c.arguments ?? null })) : []));
      items.push({ type: "assistant", text: reply, span_id: s.id, model: s.model, tokens: s.tokens, tool_calls: calls, error: s.error });
      // Later calls repeat earlier assistant turns in their input; don't show them twice.
      if (reply) seen.add(`assistant:${reply}`);
    } else if (s.kind === "TOOL" || s.kind === "MCP_TOOL") {
      items.push({ type: "tool", name: s.toolName ?? s.name, span_id: s.id, input: s.input, output: s.output, status: s.status, error: s.error, duration_ms: Math.round(s.durationMs) });
    } else if (s.kind === "AGENT" && s.id !== root.id) {
      items.push({
        type: "agent",
        name: s.name.replace(/^openai_agents\.agent\./, ""),
        span_id: s.id,
        status: s.status,
        duration_ms: Math.round(s.durationMs),
        llm_calls: count(s, "LLM"),
        tool_calls: count(s, "TOOL") + count(s, "MCP_TOOL"),
        input: preview(s.input, 300) || undefined,
        output: preview(s.output, 300) || undefined,
        error: s.error,
      });
    }
  }
  // An assistant step with nothing recorded (some SDKs drop the tool call from the LLM output):
  // the tool spans that ran right after it say what it called.
  items.forEach((it, i) => {
    if (it.type !== "assistant" || it.history || it.text || it.tool_calls.length || it.error) return;
    const next: ChatItem[] = [];
    for (let j = i + 1; j < items.length && items[j].type === "tool"; j++) next.push(items[j]);
    if (next.length) {
      it.tool_calls = next.map((x) => (x.type === "tool" ? { name: x.name, arguments: x.input ?? null } : { name: "tool", arguments: null }));
      it.inferred = true;
    }
  });
  if (!llmCalls) {
    // No LLM spans in scope: the root's own input and output still make a turn.
    const input = text(root.input);
    const output = text(root.output);
    if (input) items.unshift({ type: "user", text: input, span_id: root.id });
    if (output) items.push({ type: "assistant", text: output, span_id: root.id, tool_calls: [], error: root.error });
  }
  return { root: root.id, items };
}
