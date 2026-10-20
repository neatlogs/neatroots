import { kvToPlain, setOwn, type KeyValue, type OtlpSpan, type Plain } from "../otlp/types.js";

/**
 * Span kinds from the public Neatlogs telemetry schema. The SDKs send them
 * lowercase in `neatlogs.span.kind`; neatroots keeps them uppercase.
 */
export type SpanKind =
  | "WORKFLOW"
  | "AGENT"
  | "CHAIN"
  | "TASK"
  | "LLM"
  | "TOOL"
  | "MCP_TOOL"
  | "RETRIEVER"
  | "RERANKER"
  | "EMBEDDING"
  | "VECTOR_STORE"
  | "MEMORY"
  | "GUARDRAIL"
  | "EVALUATOR"
  | "LOG"
  | "HTTP"
  | "INTERNAL"
  | "UNKNOWN";

const KNOWN_KINDS = new Set<string>([
  "WORKFLOW", "AGENT", "CHAIN", "TASK", "LLM", "TOOL", "MCP_TOOL", "RETRIEVER", "RERANKER",
  "EMBEDDING", "VECTOR_STORE", "MEMORY", "GUARDRAIL", "EVALUATOR", "LOG", "HTTP", "INTERNAL", "UNKNOWN",
]);

export const COMPLETE_MARKER = "neatlogs.trace.complete";

/** Roles that carry the system prompt: OpenAI's newer models take it as a "developer" message. */
export function isSystemRole(role: unknown): boolean {
  return role === "system" || role === "developer";
}

export interface SpanView {
  kind: SpanKind;
  isMarker: boolean;
  model?: string;
  provider?: string;
  toolName?: string;
  sessionId?: string;
  workflow?: string;
  agentName?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input?: Plain;
  output?: Plain;
  error?: string;
  /** Public SDK flag: the caller abandoned a streamed reply. Missing is unknown. */
  streamCancelled?: boolean;
  interrupted?: boolean;
  terminationReason?: string;
  /** Tool calls the LLM asked for (LLM spans only). */
  toolCalls?: { id?: string; name: string; arguments: Plain }[];
  /** Tools offered to the LLM (LLM spans only). */
  tools?: string[];
}

type Attrs = Record<string, Plain>;

function str(v: Plain | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.length ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function int(v: Plain | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** Parses a JSON string when it looks like JSON, otherwise returns it as is. */
export function maybeJson(v: Plain | undefined): Plain | undefined {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t) return v;
  if ((t[0] === "{" && t.endsWith("}")) || (t[0] === "[" && t.endsWith("]")) || (t[0] === '"' && t.endsWith('"'))) {
    try {
      return JSON.parse(t) as Plain;
    } catch {
      return v;
    }
  }
  return v;
}

function first(attrs: Attrs, keys: string[]): Plain | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Collects `prefix.N.field` (and `prefix.N.field.M.sub`) attributes into an array
 * of objects, as the SDKs flatten message lists.
 */
export function collectIndexed(attrs: Attrs, prefix: string): Record<string, Plain>[] {
  const p = prefix + ".";
  const rows = new Map<number, Record<string, Plain>>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(p)) continue;
    const rest = key.slice(p.length);
    const dot = rest.indexOf(".");
    const idxStr = dot === -1 ? rest : rest.slice(0, dot);
    if (!/^\d+$/.test(idxStr)) continue;
    const idx = Number(idxStr);
    const row = rows.get(idx) ?? {};
    if (dot === -1) {
      const parsed = maybeJson(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) for (const [k, v] of Object.entries(parsed)) setOwn(row, k, v as Plain);
      else row.value = parsed ?? null;
    } else {
      setPath(row, rest.slice(dot + 1).split("."), value);
    }
    rows.set(idx, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

/** Keys come from span attributes, so only own properties are read and written (see setOwn). */
function setPath(obj: Record<string, Plain>, parts: string[], value: Plain): void {
  let cur: Record<string, Plain> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
    if (!next || typeof next !== "object" || Array.isArray(next)) setOwn(cur, k, {});
    cur = cur[k] as Record<string, Plain>;
  }
  setOwn(cur, parts[parts.length - 1], value);
}

function normKind(raw: string | undefined): SpanKind | undefined {
  if (!raw) return undefined;
  let k = raw.trim().toUpperCase();
  if (k.startsWith("NEATLOGS.")) k = k.slice("NEATLOGS.".length);
  const alias: Record<string, SpanKind> = {
    AGENT_ACTION: "AGENT",
    TOOL_CALL: "TOOL",
    CHAT: "LLM",
    COMPLETION: "LLM",
    GENERATION: "LLM",
    RETRIEVAL: "RETRIEVER",
    EMBEDDINGS: "EMBEDDING",
    CREWAI_TASK: "TASK",
    EXECUTE_TOOL: "TOOL",
    INVOKE_AGENT: "AGENT",
    CREATE_AGENT: "AGENT",
    TEXT_COMPLETION: "LLM",
    GENERATE_CONTENT: "LLM",
  };
  if (alias[k]) return alias[k];
  return KNOWN_KINDS.has(k) ? (k as SpanKind) : undefined;
}

/** Vercel AI SDK spans: ai.toolCall is a tool, ai.*.doGenerate / doStream is one LLM call. */
function vercelKind(span: OtlpSpan, attrs: Attrs): SpanKind | undefined {
  const op = str(attrs["ai.operationId"]) ?? (span.name.startsWith("ai.") ? span.name.split(" ")[0] : undefined);
  if (!op) return undefined;
  if (op === "ai.toolCall") return "TOOL";
  if (/\.do(Generate|Stream)$/.test(op)) return "LLM";
  if (/^ai\.(embed|embedMany)/.test(op)) return "EMBEDDING";
  if (/^ai\.(generateText|streamText|generateObject|streamObject)$/.test(op)) return "AGENT";
  return undefined;
}

function deriveKind(span: OtlpSpan, attrs: Attrs): SpanKind {
  if (span.name === COMPLETE_MARKER || attrs[COMPLETE_MARKER] === true) return "INTERNAL";
  return (
    normKind(str(attrs["neatlogs.span.kind"])) ??
    vercelKind(span, attrs) ??
    normKind(str(attrs["openinference.span.kind"])) ??
    normKind(str(attrs["gen_ai.operation.name"])) ??
    normKind(str(attrs["traceloop.span.kind"])) ??
    (attrs["gen_ai.request.model"] || attrs["llm.model_name"] ? "LLM" : undefined) ??
    (attrs["http.method"] || attrs["http.request.method"] ? "HTTP" : undefined) ??
    "UNKNOWN"
  );
}

function llmMessages(attrs: Attrs, dir: "input" | "output"): Plain | undefined {
  const flat = collectIndexed(attrs, `neatlogs.llm.${dir}_messages`);
  if (flat.length) return flat;
  const oi = collectIndexed(attrs, `llm.${dir}_messages`).map((m) => (m.message as Record<string, Plain>) ?? m);
  if (oi.length) return oi;
  const genai = dir === "input" ? collectIndexed(attrs, "gen_ai.prompt") : collectIndexed(attrs, "gen_ai.completion");
  if (genai.length) return genai;
  const json = maybeJson(first(attrs, [`gen_ai.${dir}.messages`]));
  if (json !== undefined) return normalizeParts(json);
  if (dir === "input") {
    const prompt = maybeJson(first(attrs, ["ai.prompt.messages"]));
    if (prompt !== undefined) return normalizeParts(prompt);
  } else {
    const text = first(attrs, ["ai.response.text"]);
    const calls = maybeJson(first(attrs, ["ai.response.toolCalls"]));
    if (text !== undefined || calls !== undefined) {
      const msg: Record<string, Plain> = { role: "assistant", content: str(text) ?? "" };
      if (Array.isArray(calls))
        msg.tool_calls = calls.map((c) => {
          const o = (c ?? {}) as Record<string, Plain>;
          return { id: str(o.toolCallId) ?? null, name: str(o.toolName) ?? "tool", arguments: maybeJson(o.args ?? o.input) ?? null };
        });
      return [msg];
    }
  }
  return undefined;
}

/**
 * OpenTelemetry GenAI messages ({role, parts: [{type: "text", content}]}) and AI SDK
 * content arrays ({type: "text", text}) flattened to {role, content} so they read like chat.
 */
function normalizeParts(v: Plain): Plain {
  if (!Array.isArray(v)) return v;
  return v.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const msg = m as Record<string, Plain>;
    const parts = Array.isArray(msg.parts) ? msg.parts : Array.isArray(msg.content) ? msg.content : null;
    if (!parts) return msg;
    const texts: string[] = [];
    const calls: Plain[] = [];
    for (const p of parts) {
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      const part = p as Record<string, Plain>;
      if (part.type === "text") texts.push(str(part.content ?? part.text) ?? "");
      else if (part.type === "tool_call" || part.type === "tool-call") calls.push({ id: str(part.id ?? part.toolCallId) ?? null, name: str(part.name ?? part.toolName) ?? "tool", arguments: maybeJson(part.arguments ?? part.args ?? part.input) ?? null });
      else if (part.type === "tool_call_response" || part.type === "tool-result") texts.push(str(part.response ?? part.result ?? part.output) ?? "");
    }
    const out: Record<string, Plain> = { role: msg.role ?? "user", content: texts.join("\n") };
    if (calls.length) out.tool_calls = calls;
    return out;
  });
}

function llmToolCalls(attrs: Attrs): SpanView["toolCalls"] {
  const calls = collectIndexed(attrs, "neatlogs.llm.tool_calls");
  if (!calls.length) return undefined;
  return calls.map((c) => ({
    id: str(c.id),
    name: str(c.name) ?? str((c.function as Record<string, Plain> | undefined)?.name) ?? "tool",
    arguments: maybeJson(c.arguments ?? (c.function as Record<string, Plain> | undefined)?.arguments) ?? null,
  }));
}

function exceptionMessage(span: OtlpSpan): string | undefined {
  for (const e of span.events) {
    if (e.name !== "exception") continue;
    const a = kvToPlain(e.attributes);
    const type = str(a["exception.type"]);
    const msg = str(a["exception.message"]);
    if (type || msg) return [type, msg].filter(Boolean).join(": ");
  }
  return undefined;
}

export function buildView(span: OtlpSpan, resourceAttrs: KeyValue[]): SpanView {
  const attrs = kvToPlain(span.attributes);
  const res = kvToPlain(resourceAttrs);
  const kind = deriveKind(span, attrs);
  const isMarker = span.name === COMPLETE_MARKER || attrs[COMPLETE_MARKER] === true;
  const view: SpanView = { kind, isMarker };

  view.sessionId = str(first(attrs, ["neatlogs.session.id", "session.id", "neatlogs.conversation.id", "gen_ai.conversation.id"]));
  view.workflow = str(
    first(attrs, ["neatlogs.workflow_name", "neatlogs.workflow.name"]) ??
      first(res, ["neatlogs.workflow_name", "neatlogs.workflow.name", "service.name"]),
  );
  view.agentName = str(first(attrs, ["neatlogs.agent.name", "agent.name", "gen_ai.agent.name"]));
  view.model = str(first(attrs, ["neatlogs.llm.model_name", "gen_ai.response.model", "gen_ai.request.model", "llm.model_name", "ai.response.model", "ai.model.id", "neatlogs.embedding.model_name"]));
  view.provider = str(first(attrs, ["neatlogs.llm.provider", "neatlogs.provider", "gen_ai.system", "gen_ai.provider.name", "llm.provider", "ai.model.provider"]));
  view.promptTokens = int(first(attrs, ["neatlogs.llm.token_count.prompt", "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "ai.usage.promptTokens", "ai.usage.inputTokens"]));
  view.completionTokens = int(first(attrs, ["neatlogs.llm.token_count.completion", "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion", "ai.usage.completionTokens", "ai.usage.outputTokens"]));
  view.totalTokens =
    int(first(attrs, ["neatlogs.llm.token_count.total", "gen_ai.usage.total_tokens", "llm.token_count.total"])) ??
    (view.promptTokens !== undefined || view.completionTokens !== undefined
      ? (view.promptTokens ?? 0) + (view.completionTokens ?? 0)
      : undefined);

  if (kind === "TOOL" || kind === "MCP_TOOL") {
    view.toolName = str(first(attrs, ["neatlogs.tool.name", "tool.name", "gen_ai.tool.name", "ai.toolCall.name", "traceloop.entity.name"])) ?? span.name;
  }

  const genericIn = ["neatlogs.input.value", "input.value", "traceloop.entity.input"];
  const genericOut = ["neatlogs.output.value", "output.value", "traceloop.entity.output"];
  switch (kind) {
    case "LLM": {
      const msgs = llmMessages(attrs, "input");
      view.input = msgs ?? maybeJson(first(attrs, ["neatlogs.llm.input", ...genericIn]));
      const out = llmMessages(attrs, "output");
      view.toolCalls = llmToolCalls(attrs);
      view.output = out ?? maybeJson(first(attrs, ["neatlogs.llm.output", ...genericOut]));
      if (view.toolCalls && Array.isArray(view.output) && view.output.length) {
        const m = view.output[0] as Record<string, Plain>;
        if (m && typeof m === "object" && !m.tool_calls) {
          m.tool_calls = view.toolCalls.map((c) => ({ id: c.id ?? null, name: c.name, arguments: c.arguments }));
        }
      } else if (view.toolCalls && view.output === undefined) {
        view.output = [{ role: "assistant", tool_calls: view.toolCalls.map((c) => ({ id: c.id ?? null, name: c.name, arguments: c.arguments })) }];
      }
      const tools = collectIndexed(attrs, "neatlogs.llm.tools").map((t) => str(t.name)).filter((x): x is string => !!x);
      if (tools.length) view.tools = tools;
      break;
    }
    case "TOOL":
    case "MCP_TOOL":
      view.input = maybeJson(first(attrs, ["neatlogs.tool.input", "neatlogs.tool.arguments", ...genericIn, "gen_ai.tool.call.arguments", "ai.toolCall.args", "ai.toolCall.input"]));
      view.output = maybeJson(first(attrs, ["neatlogs.tool.output", ...genericOut, "gen_ai.tool.call.result", "ai.toolCall.result", "ai.toolCall.output"]));
      break;
    case "WORKFLOW":
      view.input = maybeJson(first(attrs, ["neatlogs.workflow.input", ...genericIn]));
      view.output = maybeJson(first(attrs, ["neatlogs.workflow.output", ...genericOut]));
      break;
    case "AGENT":
      view.input = maybeJson(first(attrs, ["neatlogs.agent.input", ...genericIn, "ai.prompt"]));
      view.output = maybeJson(first(attrs, ["neatlogs.agent.output", ...genericOut, "ai.response.text"]));
      break;
    case "RETRIEVER":
      view.input = maybeJson(first(attrs, ["neatlogs.retriever.query", ...genericIn]));
      view.output = maybeJson(first(attrs, ["neatlogs.retriever.documents", ...genericOut])) ?? collectIndexed(attrs, "retrieval.documents");
      break;
    case "EMBEDDING":
      view.input = maybeJson(first(attrs, ["neatlogs.embedding.text", ...genericIn]));
      view.output = maybeJson(first(attrs, genericOut));
      break;
    default: {
      const k = kind.toLowerCase();
      view.input = maybeJson(first(attrs, [`neatlogs.${k}.input`, ...genericIn]));
      view.output = maybeJson(first(attrs, [`neatlogs.${k}.output`, ...genericOut]));
    }
  }

  if (span.status.code === 2) view.error = span.status.message || exceptionMessage(span) || "error";
  else view.error = exceptionMessage(span);
  if (attrs["neatlogs.trace.interrupted"] === true || attrs["neatlogs.trace.interrupted"] === "true") view.interrupted = true;
  if (typeof attrs["neatlogs.stream.cancelled"] === "boolean") view.streamCancelled = attrs["neatlogs.stream.cancelled"];
  view.terminationReason = str(attrs["neatlogs.trace.termination.reason"]);
  return view;
}

/** A bounded, human-readable rendering of a value, for previews and the LLM. */
export function preview(v: Plain | undefined, max = 400): string {
  if (v === undefined || v === null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else if (Array.isArray(v) && v.every((m) => m && typeof m === "object" && "role" in (m as object))) {
    s = (v as Record<string, Plain>[])
      .map((m) => {
        const content = typeof m.content === "string" ? (m.content === "null" ? "" : m.content) : m.content ? JSON.stringify(m.content) : "";
        const calls = Array.isArray(m.tool_calls)
          ? " → " + (m.tool_calls as Record<string, Plain>[]).map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")
          : "";
        return `${m.role}: ${content}${calls}`;
      })
      .join("\n");
  } else s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
