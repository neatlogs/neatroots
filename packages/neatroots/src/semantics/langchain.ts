import type { Plain } from "../otlp/types.js";

// LangChain and LangGraph put their own message objects in span values, and each instrumentation
// serializes them its own way. Checks that compare tool results or read the run's answer need the
// content inside, not the envelope: a ToolMessage carries a tool_call_id that changes on every
// call, and a graph's final state is the whole conversation, not the answer. The forms seen:
//
//   message_to_dict   {"type": "tool", "data": {"content": "...", "tool_call_id": "call_1", ...}}
//                     OpenInference, and the Neatlogs SDK's instrumentations=["langchain"]
//   dumpd / to_json   {"lc": 1, "type": "constructor", "id": [..., "ToolMessage"], "kwargs": {...}}
//                     OpenLLMetry, inside its {"output": ..., "kwargs": ...} envelope
//   model_dump        {"content": "...", "type": "tool", "tool_call_id": "call_1", ...}
//                     OpenInference's fallback when message_to_dict is unavailable
//   str(message)      content='Sunny in Lagos' name='get_weather' tool_call_id='call_1'
//                     the Neatlogs SDK's own callback handler (pydantic's repr of the fields)
//
// Everything here reads one of those into neatroots' chat shape, {role, content, tool_calls?},
// so previews, evidence and rules see the same thing whichever instrumentation sent the run.

type Obj = Record<string, Plain>;
/** A message in neatroots' chat shape. */
export type Message = Obj & { role: string; content: Plain };

const ROLE_OF_TYPE: Record<string, string> = { human: "user", user: "user", ai: "assistant", assistant: "assistant", system: "system", developer: "developer", tool: "tool", function: "tool", chat: "chat" };

function isObj(v: Plain | undefined): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function jsonOf(s: string): Plain | undefined {
  const t = s.trim();
  if (!((t[0] === "{" && t.endsWith("}")) || (t[0] === "[" && t.endsWith("]")))) return undefined;
  try {
    return JSON.parse(t) as Plain;
  } catch {
    return undefined;
  }
}

function str(v: Plain | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** "ai", "AIMessageChunk", "HumanMessage" → the message type LangChain names it by. */
function messageType(raw: Plain | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.toLowerCase().replace(/message(chunk)?$/, "");
  return t in ROLE_OF_TYPE ? t : undefined;
}

function toolCalls(v: Plain | undefined): Obj[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const calls: Obj[] = [];
  for (const c of v) {
    if (!isObj(c)) continue;
    const fn = isObj(c.function) ? c.function : undefined;
    const args = c.args ?? c.arguments ?? fn?.arguments ?? null;
    calls.push({ id: str(c.id) ?? null, name: str(c.name) ?? str(fn?.name) ?? "tool", arguments: typeof args === "string" ? (jsonOf(args) ?? args) : args });
  }
  return calls.length ? calls : undefined;
}

/** Builds the chat-shaped message from a message's fields (data, kwargs, model_dump or repr fields). */
function fromFields(type: string | undefined, f: Obj): Message | undefined {
  if (!("content" in f)) return undefined;
  const t = type ?? ("tool_call_id" in f ? "tool" : "tool_calls" in f || "invalid_tool_calls" in f ? "ai" : "human");
  const role = t === "chat" ? (str(f.role) ?? "user") : (ROLE_OF_TYPE[t] ?? t);
  const content = typeof f.content === "string" ? (jsonOf(f.content) ?? f.content) : (f.content ?? "");
  const m: Message = { role, content };
  const name = str(f.name);
  if (name) m.name = name;
  const callId = str(f.tool_call_id);
  if (callId) m.tool_call_id = callId;
  const status = str(f.status);
  if (status && role === "tool") m.status = status;
  const extra = isObj(f.additional_kwargs) ? f.additional_kwargs : undefined;
  const calls = toolCalls(f.tool_calls) ?? toolCalls(extra?.tool_calls);
  if (calls) m.tool_calls = calls;
  return m;
}

/**
 * One serialized LangChain message in any of its forms, as a chat-shaped message; undefined for
 * anything else. A string is read as JSON or as pydantic's repr of the fields.
 */
export function langChainMessage(v: Plain | undefined): Message | undefined {
  if (typeof v === "string") {
    const parsed = jsonOf(v);
    if (parsed !== undefined) return langChainMessage(parsed);
    const fields = reprFields(v);
    return fields ? fromFields(undefined, fields) : undefined;
  }
  if (!isObj(v)) return undefined;
  // message_to_dict: {"type": "tool", "data": {..., "type": "tool"}}
  const type = messageType(v.type);
  if (type && isObj(v.data) && "content" in v.data) return fromFields(type, v.data);
  // dumpd: {"lc": 1, "type": "constructor", "id": ["langchain", "schema", "messages", "ToolMessage"], "kwargs": {...}}
  if (v.lc === 1 && v.type === "constructor" && Array.isArray(v.id) && isObj(v.kwargs)) {
    const cls = messageType(v.id[v.id.length - 1]);
    return cls ? fromFields(cls, v.kwargs) : undefined;
  }
  // model_dump: the fields with a "type", and the pydantic fields no hand-written object has.
  if (type && "content" in v && ("additional_kwargs" in v || "response_metadata" in v || "tool_call_id" in v || "tool_calls" in v)) return fromFields(type, v);
  return undefined;
}

/** A message in a form other than LangChain's: a {role, content} object, or (when `loose`) a [role, text] pair or a bare string. */
function asMessage(v: Plain, loose: boolean): Message | undefined {
  if (isObj(v) && typeof v.role === "string" && "content" in v) return v as Message;
  if (!loose) return undefined;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && v[0].toLowerCase() in ROLE_OF_TYPE) return { role: ROLE_OF_TYPE[v[0].toLowerCase()], content: v[1] };
  if (typeof v === "string") return { role: "user", content: v };
  return undefined;
}

/**
 * A list of LangChain messages as chat-shaped messages, or undefined when the list is something
 * else. It has to be LangChain's: at least one element in one of LangChain's serialized forms,
 * or, under a `messages` key, one of the [role, text] pairs LangChain accepts as input. Bare
 * strings count as user messages only next to a real LangChain message, so an OpenAI request
 * body, a list of {role, content} from another framework or a tool's list of strings is left
 * as it was.
 */
export function langChainMessages(v: Plain | undefined, opts: { loose?: boolean } = {}): Message[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out: Message[] = [];
  let lc = 0;
  let pairs = 0;
  let bare = 0;
  for (const e of v) {
    const lcm = langChainMessage(e);
    const m = lcm ?? asMessage(e, !!opts.loose);
    if (!m) return undefined;
    if (lcm) lc++;
    else if (Array.isArray(e)) pairs++;
    else if (typeof e === "string") bare++;
    out.push(m);
  }
  if (!lc && (bare || !pairs)) return undefined;
  return out;
}

/**
 * A LangGraph state, {"messages": [...]} with whatever else the graph keeps: its messages read as
 * messages, the other keys kept. Just the messages when there is nothing else.
 */
function messageState(v: Plain | undefined): Plain | undefined {
  if (!isObj(v) || !Array.isArray(v.messages)) return undefined;
  const messages = langChainMessages(v.messages, { loose: true });
  if (!messages) return undefined;
  return Object.keys(v).length === 1 ? messages : { ...v, messages };
}

/**
 * OpenLLMetry's callback envelopes: the value under `key` when the object has no keys beyond
 * `allowed`. Only read on a value that came from `traceloop.entity.*` (`envelope`), or that
 * carries the handler's `kwargs` key: a tool of another framework may well return {"output": ...}.
 */
function traceloopInner(v: Plain | undefined, key: string, allowed: string[], envelope: boolean): Plain | undefined {
  if (!isObj(v) || !(key in v) || v[key] === null) return undefined;
  if (!envelope && !("kwargs" in v)) return undefined;
  for (const k of Object.keys(v)) if (!allowed.includes(k)) return undefined;
  return v[key];
}

/** Where a span value came from: `envelope` when it was OpenLLMetry's `traceloop.entity.input`/`output`. */
export interface ValueSource {
  envelope?: boolean;
}

/** A message's content as text: a string as is, content blocks by their text parts. */
export function contentText(content: Plain | undefined): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.map((p) => (typeof p === "string" ? p : isObj(p) && (p.type === "text" || p.type === undefined) && typeof p.text === "string" ? p.text : undefined)).filter((x): x is string => x !== undefined);
    if (texts.length) return texts.join("\n");
  }
  return JSON.stringify(content);
}

function stripped(m: Message): Plain {
  return typeof m.content === "string" || !Array.isArray(m.content) ? m.content : contentText(m.content);
}

const TOOL_INPUT_KEYS = ["input_str", "tags", "metadata", "inputs", "kwargs"];

/** A tool span's input as the tool's arguments: OpenLLMetry's envelope, with LangGraph's per-step metadata, removed. */
export function toolInput(v: Plain | undefined, src: ValueSource = {}): Plain | undefined {
  const inputs = traceloopInner(v, "inputs", TOOL_INPUT_KEYS, !!src.envelope);
  if (inputs !== undefined) return inputs;
  const inputStr = traceloopInner(v, "input_str", TOOL_INPUT_KEYS, !!src.envelope);
  if (typeof inputStr === "string") return jsonOf(inputStr) ?? pythonLiteral(inputStr) ?? inputStr;
  // LangChain's input_str for a dict of arguments is its Python repr: {'city': 'Lagos'}.
  if (typeof v === "string" && /^\s*[[{]/.test(v)) return jsonOf(v) ?? pythonLiteral(v) ?? v;
  return v;
}

/** A tool span's output as the tool's result: a serialized ToolMessage gives its content. */
export function toolOutput(v: Plain | undefined, src: ValueSource = {}): Plain | undefined {
  const inner = traceloopInner(v, "output", ["output", "kwargs"], !!src.envelope);
  const x = inner !== undefined ? inner : v;
  const m = langChainMessage(x);
  return m ? stripped(m) : x;
}

/** A chain, agent or workflow span's value: OpenLLMetry's envelope removed, LangChain messages read as messages. */
export function chainValue(v: Plain | undefined, src: ValueSource = {}): Plain | undefined {
  const inner = traceloopInner(v, "inputs", ["inputs", "tags", "metadata", "kwargs"], !!src.envelope) ?? traceloopInner(v, "outputs", ["outputs", "kwargs"], !!src.envelope);
  const x = inner !== undefined ? inner : v;
  const messages = messageState(x) ?? langChainMessages(x);
  if (messages) return messages;
  const one = langChainMessage(x);
  return one ?? x;
}

function isMessageList(v: Plain | undefined): v is Message[] {
  return Array.isArray(v) && v.length > 0 && v.every((m) => isObj(m) && typeof m.role === "string");
}

/** The messages in a value: a message list, or the `messages` of a state that kept its other keys. */
function messagesIn(v: Plain | undefined): Message[] | undefined {
  if (isMessageList(v)) return v;
  if (isObj(v) && isMessageList(v.messages)) return v.messages;
  return undefined;
}

/** The text of the last message with `role` in a message list; undefined when there is none. */
export function lastMessageText(v: Plain | undefined, role: string): string | undefined {
  const msgs = messagesIn(v);
  if (!msgs) return undefined;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === role) return contentText(msgs[i].content);
  return undefined;
}

/**
 * The agent's answer in a value that is messages: the last message's text when the assistant
 * spoke last, "" when the conversation ended on something else (a tool result, say), and
 * undefined when the value isn't messages at all.
 */
export function finalReply(v: Plain | undefined): string | undefined {
  const msgs = messagesIn(v);
  if (msgs) {
    const last = msgs[msgs.length - 1];
    return last.role === "assistant" ? contentText(last.content) : "";
  }
  if (isObj(v) && typeof v.role === "string" && "content" in v) return v.role === "assistant" ? contentText(v.content) : "";
  return undefined;
}

// --- Python literals -------------------------------------------------------------------------
// pydantic's str() of a message is "field=value field=value", each value a Python literal, and
// OpenLLMetry's input_str is the Python repr of the arguments. Anything the parser doesn't
// understand leaves the string as it was.

const FAIL = Symbol("not a python literal");
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
/** Lists and dicts nest at most this deep; past it the text is not read as a literal (the reader recurses once per level). */
const MAX_DEPTH = 256;

class PyReader {
  i = 0;
  private depth = 0;
  constructor(private readonly s: string) {}

  value(): Plain {
    const s = this.s;
    const c = s[this.i];
    if (c === "'" || c === '"') return this.string(c);
    if (c === "[" || c === "(" || c === "{") {
      if (++this.depth > MAX_DEPTH) throw FAIL;
      const v = c === "{" ? this.dict() : this.sequence(c === "[" ? "]" : ")");
      this.depth--;
      return v;
    }
    for (const [word, val] of [["None", null], ["True", true], ["False", false]] as const) {
      if (s.startsWith(word, this.i)) {
        this.i += word.length;
        return val;
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(this.i, this.i + 40));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    throw FAIL;
  }

  private string(quote: string): string {
    const s = this.s;
    let out = "";
    for (this.i++; this.i < s.length; this.i++) {
      const c = s[this.i];
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = s[++this.i];
      if (e === "x" || e === "u" || e === "U") {
        const n = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = s.slice(this.i + 1, this.i + 1 + n);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) throw FAIL;
        out += String.fromCodePoint(parseInt(hex, 16));
        this.i += n;
      } else if (e in ESCAPES) out += ESCAPES[e];
      else out += "\\" + e;
    }
    throw FAIL;
  }

  private spaces(): void {
    while (this.s[this.i] === " ") this.i++;
  }

  private sequence(close: string): Plain[] {
    const out: Plain[] = [];
    this.i++;
    this.spaces();
    while (this.s[this.i] !== close) {
      if (this.i >= this.s.length) throw FAIL;
      out.push(this.value());
      this.spaces();
      if (this.s[this.i] === ",") {
        this.i++;
        this.spaces();
      } else if (this.s[this.i] !== close) throw FAIL;
    }
    this.i++;
    return out;
  }

  private dict(): Obj {
    const out: Obj = {};
    this.i++;
    this.spaces();
    while (this.s[this.i] !== "}") {
      if (this.i >= this.s.length) throw FAIL;
      const key = this.value();
      this.spaces();
      if (this.s[this.i] !== ":") throw FAIL;
      this.i++;
      this.spaces();
      out[typeof key === "string" ? key : String(key)] = this.value();
      this.spaces();
      if (this.s[this.i] === ",") {
        this.i++;
        this.spaces();
      } else if (this.s[this.i] !== "}") throw FAIL;
    }
    this.i++;
    return out;
  }
}

/** One Python literal (a repr'd dict, list, string, number, None or bool); undefined when the text is anything else. */
export function pythonLiteral(s: string): Plain | undefined {
  const r = new PyReader(s.trim());
  try {
    const v = r.value();
    return r.i === s.trim().length ? v : undefined;
  } catch (e) {
    if (e === FAIL) return undefined;
    throw e;
  }
}

/** pydantic's "content='…' name='…' tool_call_id='…'" as its fields; undefined for other text. */
export function reprFields(s: string): Obj | undefined {
  if (!s.startsWith("content=")) return undefined;
  const r = new PyReader(s);
  const out: Obj = {};
  try {
    while (r.i < s.length) {
      const key = /^([A-Za-z_]\w*)=/.exec(s.slice(r.i, r.i + 64));
      if (!key) return undefined;
      r.i += key[0].length;
      out[key[1]] = r.value();
      if (r.i >= s.length) break;
      if (s[r.i] !== " ") return undefined;
      r.i++;
    }
  } catch (e) {
    if (e === FAIL) return undefined;
    throw e;
  }
  return out;
}
