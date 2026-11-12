import type { Plain } from "../otlp/types.js";

/**
 * OpenTelemetry GenAI message content sent as events: the `gen_ai.*.message` and `gen_ai.choice`
 * events, the older `gen_ai.content.prompt` / `gen_ai.content.completion`, and the newer
 * `gen_ai.client.inference.operation.details`. They arrive as span events or as log records
 * correlated to the span by trace and span id; both come in here as a name plus attributes (a log
 * record's body is the event's payload).
 */
export interface GenAiEvent {
  name: string;
  attributes: Record<string, Plain>;
  /** When it happened, as unix nanoseconds, so events from a span and from logs can be put in order. */
  timeNs?: string;
  /** A log record's body, when it is an object. */
  body?: Plain;
}

export interface GenAiMessages {
  input?: Plain;
  output?: Plain;
  finishReason?: string;
}

const MESSAGE_ROLES: Record<string, string> = {
  "gen_ai.system.message": "system",
  "gen_ai.developer.message": "developer",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};

type Obj = Record<string, Plain>;

/** Whether a value is a plain object (not an array or a scalar). */
const isObj = (v: Plain | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** A value that may be JSON text, decoded when it is; anything else comes back as it was. */
function parse(v: Plain | undefined): Plain | undefined {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return v;
  try {
    return JSON.parse(t) as Plain;
  } catch {
    return v;
  }
}

/** The event's payload: a log record's body, with the event's own attributes alongside. */
function payload(e: GenAiEvent): Obj {
  const body = parse(e.body);
  // Some senders put a span event's body, as JSON, in a single `gen_ai.event.content` attribute.
  const packed = parse(e.attributes["gen_ai.event.content"]);
  return { ...e.attributes, ...(isObj(packed) ? packed : {}), ...(isObj(body) ? body : body !== undefined ? { content: body } : {}) };
}

/** OpenAI-shaped tool calls from an event, with their function arguments decoded; nothing when there are none. */
function toolCalls(v: Plain | undefined): Plain[] | undefined {
  const calls = parse(v);
  if (!Array.isArray(calls) || !calls.length) return undefined;
  return calls.map((c) => {
    const o = isObj(c) ? c : {};
    const fn = isObj(o.function) ? o.function : o;
    return { id: (o.id as string | undefined) ?? null, name: String(fn.name ?? "tool"), arguments: parse(fn.arguments) ?? null };
  });
}

/** A chat message with the given role from an event payload: its content, tool calls and tool call id. */
function message(role: string, p: Obj): Obj {
  const content = parse(p.content);
  const m: Obj = { role: typeof p.role === "string" && p.role ? p.role : role, content: typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content) };
  const calls = toolCalls(p.tool_calls);
  if (calls) m.tool_calls = calls;
  if (role === "tool" && p.id !== undefined) m.tool_call_id = p.id;
  return m;
}

/** A value (or its JSON text) as a list: arrays as they are, one value as a list of one, nothing as empty. */
const asList = (v: Plain | undefined): Plain[] => {
  const p = parse(v);
  return Array.isArray(p) ? p : p === undefined ? [] : [p];
};

/**
 * The input and output messages the events carry, in order. Returns nothing for the parts the
 * events don't cover, so the caller can fall back to attributes first and use these last.
 */
export function messagesFromEvents(events: GenAiEvent[]): GenAiMessages {
  const input: Plain[] = [];
  const choices: { index: number; msg: Obj }[] = [];
  let output: Plain[] | undefined;
  let finishReason: string | undefined;
  let system: Plain | undefined;
  for (const e of events) {
    const role = Object.hasOwn(MESSAGE_ROLES, e.name) ? MESSAGE_ROLES[e.name] : undefined;
    const p = payload(e);
    if (role) {
      input.push(message(role, p));
    } else if (e.name === "gen_ai.choice") {
      const inner = isObj(parse(p.message)) ? (parse(p.message) as Obj) : p;
      choices.push({ index: Number(p.index) || 0, msg: message("assistant", inner) });
      if (typeof p.finish_reason === "string" && p.finish_reason && !finishReason) finishReason = p.finish_reason;
    } else if (e.name === "gen_ai.content.prompt") {
      input.push(...asList(p["gen_ai.prompt"] ?? p.content));
    } else if (e.name === "gen_ai.content.completion") {
      output = [...(output ?? []), ...asList(p["gen_ai.completion"] ?? p.content)];
    } else if (e.name === "gen_ai.client.inference.operation.details") {
      input.push(...asList(p["gen_ai.input.messages"]));
      const out = asList(p["gen_ai.output.messages"]);
      output = [...(output ?? []), ...out];
      system ??= parse(p["gen_ai.system_instructions"]);
      // The newer shape: the response's finish reasons, else the first output message's own.
      const reasons = asList(p["gen_ai.response.finish_reasons"]);
      const reason = [reasons[0], ...out.map((m) => (isObj(m) ? m.finish_reason : undefined))].find((r) => typeof r === "string" && r);
      if (typeof reason === "string" && !finishReason) finishReason = reason;
    }
  }
  if (choices.length) output = [...(output ?? []), ...choices.sort((a, b) => a.index - b.index).map((c) => c.msg)];
  const sys = system === undefined ? [] : [{ role: "system", content: typeof system === "string" ? system : JSON.stringify(system) }];
  const all = [...sys, ...input];
  return { input: all.length ? all : undefined, output: output?.length ? output : undefined, finishReason };
}

/** The event names this reader understands: the only ones worth reading back from stored logs. */
export const GENAI_EVENT_NAMES: readonly string[] = [
  ...Object.keys(MESSAGE_ROLES),
  "gen_ai.choice",
  "gen_ai.content.prompt",
  "gen_ai.content.completion",
  "gen_ai.client.inference.operation.details",
];

const GENAI_EVENT_SET = new Set(GENAI_EVENT_NAMES);

/** Whether an event name is one this reader understands. */
export function isGenAiEvent(name: string | null | undefined): boolean {
  return !!name && GENAI_EVENT_SET.has(name);
}
