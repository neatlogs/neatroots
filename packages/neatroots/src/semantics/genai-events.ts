import { kvToPlain, type OtlpEvent, type Plain } from "../otlp/types.js";
import { maybeJson, normalizeParts } from "./view.js";

/** A derived event, never added to the lossless OTLP span. */
export interface GenaiEvent { name: string; timeUnixNano: string; body: Plain }

function object(v: Plain | undefined): Record<string, Plain> {
  const parsed = maybeJson(v);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function message(v: Plain, role: string): Plain | undefined {
  const parsed = maybeJson(v);
  const m = typeof parsed === "string" ? { content: parsed } : object(parsed);
  if (m.content === undefined && !m.parts && !m.tool_calls) return undefined;
  const normalized = (normalizeParts([{ ...m, role: m.role ?? role }]) as Plain[])[0];
  const out = object(normalized);
  if (out.role === "tool" && out.id !== undefined && out.tool_call_id === undefined) out.tool_call_id = out.id;
  if (Array.isArray(out.tool_calls)) out.tool_calls = out.tool_calls.map((c) => {
    const call = object(c), fn = object(call.function);
    return { id: call.id ?? null, name: call.name ?? fn.name ?? "tool", arguments: maybeJson(call.arguments ?? fn.arguments) ?? null };
  });
  return out;
}

/** Identity uses message semantics, ignoring exporter metadata and map insertion order. */
function messageIdentity(v: Plain | undefined): Plain {
  const m = object(v);
  return Object.fromEntries(["role", "content", "tool_calls", "tool_call_id", "name"].filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
}

function canonical(v: Plain): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function identityBody(name: string, body: Plain): Plain {
  const b = object(body);
  const role = /^gen_ai\.(system|user|assistant|tool)\.message$/.exec(name)?.[1];
  if (role) return messageIdentity(message(body, role));
  if (name === "gen_ai.choice") return { index: Number(b.index) || 0, message: messageIdentity(message(b.message ?? b, "assistant")) };
  if (name === "gen_ai.client.inference.operation.details") {
    const messages = (v: Plain | undefined) => {
      const parsed = maybeJson(v);
      const normalized = Array.isArray(parsed) ? normalizeParts(parsed) as Plain[] : [];
      return normalized.map(messageIdentity);
    };
    return { input: messages(b["gen_ai.input.messages"]), output: messages(b["gen_ai.output.messages"]) };
  }
  const input = name.endsWith("prompt");
  const value = maybeJson(b[input ? "gen_ai.prompt" : "gen_ai.completion"] ?? b.content);
  return { index: Number(b.index) || 0, messages: (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v) => messageIdentity(message(v, input ? "user" : "assistant"))) };
}

/** Public OTel GenAI event conventions, including pre-1.37 message events. */
export function genaiMessages(events: OtlpEvent[], logs: GenaiEvent[]): { input?: Plain; output?: Plain } {
  const all = [
    ...events.map((e) => ({ name: e.name, timeUnixNano: e.timeUnixNano, body: kvToPlain(e.attributes) as Plain, fromSpan: true })),
    ...logs.map((e) => ({ ...e, fromSpan: false })),
  ].sort((a, b) => {
    const nanos = (v: string) => /^\d+$/.test(v) ? BigInt(v) : 0n;
    const x = nanos(a.timeUnixNano), y = nanos(b.timeUnixNano);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const input: Plain[] = [], choices: { index: number; message: Plain }[] = [];
  let detailsIn: Plain | undefined, detailsOut: Plain | undefined;
  const seen = new Set<string>();
  for (const e of all) {
    // Export retries and an event mirrored as both a span event and a log are one observation.
    const identity = canonical([e.name, e.timeUnixNano, identityBody(e.name, e.body)]);
    if (!e.fromSpan && seen.has(identity)) continue;
    seen.add(identity);
    const b = object(e.body);
    const role = /^gen_ai\.(system|user|assistant|tool)\.message$/.exec(e.name)?.[1];
    if (role) {
      const m = message(e.body, role);
      if (m) input.push(m);
    } else if (e.name === "gen_ai.choice") {
      const m = message(b.message ?? b, "assistant");
      if (m) choices.push({ index: Number(b.index) || 0, message: m });
    } else if (e.name === "gen_ai.content.prompt" || e.name === "gen_ai.content.completion") {
      const isInput = e.name.endsWith("prompt");
      const value = maybeJson(b[isInput ? "gen_ai.prompt" : "gen_ai.completion"] ?? b.content);
      const messages = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const v of messages) {
        const m = message(v, isInput ? "user" : "assistant");
        if (m) { if (isInput) input.push(m); else choices.push({ index: Number(b.index) || 0, message: m }); }
      }
    } else if (e.name === "gen_ai.client.inference.operation.details") {
      const i = maybeJson(b["gen_ai.input.messages"]), o = maybeJson(b["gen_ai.output.messages"]);
      if (Array.isArray(i)) detailsIn = normalizeParts(i);
      if (Array.isArray(o)) detailsOut = normalizeParts(o);
    }
  }
  return {
    input: detailsIn ?? (input.length ? input : undefined),
    output: detailsOut ?? (choices.length ? choices.sort((a, b) => a.index - b.index).map((c) => c.message) : undefined),
  };
}
