/**
 * @neatlogs/neatroots-steer: get neatroots findings back into a running agent.
 *
 * When neatroots finds a problem in a run that is still going, this hook adds its short note
 * to the agent's next LLM call inside a <neatroots-guidance> block and records a neatroots.guidance
 * span. It never edits tool calls or model output, and does nothing when neatroots is not running.
 *
 *   import { wrapOpenAI } from "@neatlogs/neatroots-steer";
 *   const client = wrapOpenAI(new OpenAI());
 *
 *   import { wrapLanguageModel } from "ai";
 *   const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: rootsMiddleware() });
 */

import { SteeredRequest } from "./request.js";

export const GUIDANCE_OPEN = "<neatroots-guidance>";
export const GUIDANCE_CLOSE = "</neatroots-guidance>";

export interface Note {
  id: string;
  kind: "template" | "llm" | "halt";
  text: string;
  finding_id: string | null;
}

/** Raised before an LLM call when one of your own neatroots rules says to stop the run. */
export class NeatrootsHalt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatrootsHalt";
  }
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function defaultUrl(): string {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  if (env.NEATROOTS_URL) return env.NEATROOTS_URL.replace(/\/+$/, "");
  if (env.NEATLOGS_ENDPOINT) {
    try {
      const u = new URL(env.NEATLOGS_ENDPOINT);
      if (LOCAL.has(u.hostname)) return `${u.protocol}//${u.host}`;
    } catch {
      /* ignore */
    }
  }
  return "http://localhost:4100";
}

let neatlogsMod: NeatlogsModule | null | undefined;

interface State {
  traceIdProvider?: () => string | undefined;
  url: string;
  disabled: boolean;
  mode: string;
  modeCheckedAt: number;
  modeTraceId?: string;
  downUntil: number;
  /** Requests in a row that timed out: neatroots is busy, not stopped, until there are a few. */
  timeouts: number;
}

const state: State = {
  url: defaultUrl(),
  disabled: typeof process !== "undefined" && ["0", "off", "false", "no"].includes(String(process.env.NEATROOTS_STEER ?? "").toLowerCase()),
  mode: "unknown",
  modeCheckedAt: 0,
  downUntil: 0,
  timeouts: 0,
};

/**
 * Points the hook at a neatroots app other than the default (NEATROOTS_URL or localhost:4100), or
 * supplies the current trace id yourself when you do not use the Neatlogs SDK's context.
 */
export function configure(opts: { url?: string; disabled?: boolean; traceId?: () => string | undefined; neatlogs?: unknown }): void {
  if (opts.url) state.url = opts.url.replace(/\/+$/, "");
  if (opts.traceId) state.traceIdProvider = opts.traceId;
  // Passing the app's own `neatlogs` module avoids a second copy of the SDK
  // (ESM vs CommonJS, or a linked install) that would not see the active span.
  if (opts.neatlogs) neatlogsMod = opts.neatlogs as NeatlogsModule;
  if (opts.disabled !== undefined) state.disabled = opts.disabled;
  state.mode = "unknown";
  state.modeCheckedAt = 0;
  state.modeTraceId = undefined;
  state.downUntil = 0;
  state.timeouts = 0;
}

const DEBUG = typeof process !== "undefined" && !!process.env.NEATROOTS_STEER_DEBUG;

function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[neatroots-steer]", ...args);
}

/** Timed-out requests in a row before the hook backs off as if neatroots were stopped. */
const SLOW_REPLIES_BEFORE_BACKOFF = 3;

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T | undefined> {
  if (state.disabled || Date.now() < state.downUntil) {
    debug("skip", path, state.disabled ? "disabled" : "backing off");
    return undefined;
  }
  try {
    const res = await fetch(state.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      debug(path, "HTTP", res.status);
      return undefined;
    }
    const out = (await res.json()) as T;
    state.timeouts = 0;
    debug(path, JSON.stringify(body), "->", JSON.stringify(out));
    return out;
  } catch (err) {
    debug(path, "failed:", (err as Error).message);
    // A slow answer means neatroots is busy, not stopped: ask again on the next call, so a halt
    // isn't held back. Only a few timeouts in a row, or a neatroots that can't be reached, back
    // off, so a stopped (or stuck) neatroots costs nothing per call for a while.
    if ((err as Error).name === "TimeoutError" && ++state.timeouts < SLOW_REPLIES_BEFORE_BACKOFF) return undefined;
    state.timeouts = 0;
    state.downUntil = Date.now() + 5000;
    return undefined;
  }
}

// ------------------------------------------------------------------ context

type NeatlogsModule = {
  injectTraceContext?: (carrier: Record<string, string>) => boolean;
  flush?: () => Promise<unknown>;
  trace?: <T>(opts: Record<string, unknown>, fn: (span: unknown) => T | Promise<T>) => Promise<T>;
};


async function neatlogs(): Promise<NeatlogsModule | null> {
  if (neatlogsMod !== undefined) return neatlogsMod;
  try {
    neatlogsMod = (await import("neatlogs" as string)) as NeatlogsModule;
  } catch {
    neatlogsMod = null;
  }
  if (!neatlogsMod && typeof process !== "undefined") {
    // Resolve the SDK from the app's working directory (covers linked installs).
    try {
      const { createRequire } = await import("node:module");
      const { pathToFileURL } = await import("node:url");
      const req = createRequire(`${process.cwd()}/package.json`);
      const resolved = req.resolve("neatlogs");
      neatlogsMod = (await import(pathToFileURL(resolved.replace(/index\.cjs$/, "index.mjs")).href)) as NeatlogsModule;
    } catch {
      neatlogsMod = null;
    }
  }
  return neatlogsMod;
}

/** The [traceId, spanId] of the active span, as hex, or [undefined, undefined]. */
export async function currentTrace(): Promise<[string | undefined, string | undefined]> {
  const own = state.traceIdProvider?.();
  if (own) return [own, undefined];
  const nl = await neatlogs();
  try {
    if (nl?.injectTraceContext) {
      const carrier: Record<string, string> = {};
      if (nl.injectTraceContext(carrier)) {
        const parts = (carrier.traceparent ?? "").split("-");
        if (parts.length >= 3 && parts[1].length === 32) return [parts[1], parts[2]];
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const otel = (await import("@opentelemetry/api" as string)) as { trace: { getActiveSpan(): { spanContext(): { traceId: string; spanId: string } } | undefined } };
    const ctx = otel.trace.getActiveSpan()?.spanContext();
    if (ctx && !/^0+$/.test(ctx.traceId)) return [ctx.traceId, ctx.spanId];
  } catch {
    /* no OpenTelemetry */
  }
  return [undefined, undefined];
}

async function flushSdk(): Promise<void> {
  const nl = await neatlogs();
  try {
    await nl?.flush?.();
  } catch {
    /* ignore */
  }
}

async function record(note: Note): Promise<void> {
  const nl = await neatlogs();
  try {
    await nl?.trace?.(
      {
        name: "neatroots.guidance",
        kind: "GUARDRAIL",
        input: note.text,
        attributes: {
          "neatlogs.guardrail.name": "neatroots",
          "neatlogs.guardrail.triggered": true,
          "neatlogs.guardrail.action": note.kind === "halt" ? "halt" : "guide",
          "neatroots.note.id": note.id,
          "neatroots.note.kind": note.kind,
          "neatroots.finding.id": note.finding_id ?? "",
        },
      },
      () => undefined,
    );
  } catch {
    /* ignore */
  }
}

// -------------------------------------------------------------------- notes

/** Claims the next pending note for the current run (at most one per LLM call). Throws NeatrootsHalt for halt notes. */
export async function guidance(traceId?: string): Promise<Note | undefined> {
  if (state.disabled) return undefined;
  let spanId: string | undefined;
  if (!traceId) [traceId, spanId] = await currentTrace();
  if (!traceId) {
    debug("no active trace; pass configure({ neatlogs }) if the SDK is initialized");
    return undefined;
  }
  // A cached mode belongs only to the trace that supplied it. New runs must flush and ask.
  const mode = state.modeTraceId === traceId ? state.mode : "unknown";
  if (mode === "off" && Date.now() - state.modeCheckedAt < 10_000) return undefined;
  let gateMs: number | undefined;
  if (mode === "gate" || mode === "unknown") {
    await flushSdk();
    gateMs = 300;
  }
  const res = await post<{ mode: string; note: Note | null }>("/api/steer/claim", { trace_id: traceId, span_id: spanId, gate_ms: gateMs }, gateMs ? gateMs + 500 : 500);
  if (!res) return undefined;
  state.mode = res.mode || "unknown";
  state.modeCheckedAt = Date.now();
  state.modeTraceId = traceId;
  // A note that arrives with steering off (an older neatroots) is not used.
  if (!res.note || state.mode === "off") return undefined;
  await record(res.note);
  if (res.note.kind === "halt") throw new NeatrootsHalt(res.note.text);
  return res.note;
}

export function guidanceBlock(note: Note): string {
  return `${GUIDANCE_OPEN}\nNote from neatroots, a local checker watching this run: ${note.text}\n${GUIDANCE_CLOSE}`;
}

type Msg = { role: string; content?: unknown; [k: string]: unknown };

function appendText<M extends Msg>(m: M, text: string): M {
  const content = m.content;
  if (typeof content === "string") return { ...m, content: content ? `${content}\n\n${text}` : text };
  if (Array.isArray(content)) return { ...m, content: [...content, { type: "text", text }] };
  return { ...m, content: text };
}

/** OpenAI-style chat messages with the pending note added (a copy). */
export async function applyMessages<M extends Msg>(messages: M[], note?: Note): Promise<M[]> {
  note ??= await guidance();
  if (!note || !messages.length) return messages;
  const out = [...messages];
  const last = out[out.length - 1];
  if (last.role === "user") out[out.length - 1] = appendText(last, guidanceBlock(note));
  else out.push({ role: "user", content: guidanceBlock(note) } as M);
  return out;
}

/** Anthropic Messages API variant: the note joins the last user turn (which may hold tool_result blocks). */
export async function applyAnthropic<M extends Msg>(messages: M[], note?: Note): Promise<M[]> {
  note ??= await guidance();
  if (!note || !messages.length) return messages;
  const out = [...messages];
  const last = out[out.length - 1];
  if (last.role === "user") out[out.length - 1] = appendText(last, guidanceBlock(note));
  else out.push({ role: "user", content: [{ type: "text", text: guidanceBlock(note) }] } as M);
  return out;
}

// ------------------------------------------------------------------- replay

const env = (k: string): string | undefined => (typeof process !== "undefined" ? process.env?.[k] || undefined : undefined);

/** The input to run with when neatroots replays this agent (NEATROOTS_REPLAY_INPUT), else `fallback`. */
export function replayInput<T>(fallback: T): string | T {
  return env("NEATROOTS_REPLAY_INPUT") ?? fallback;
}

/** The model and system prompt a neatroots replay asked for. The wrappers apply them for you. */
export function replayOverrides(): { model?: string; system?: string } {
  const out: { model?: string; system?: string } = {};
  const model = env("NEATROOTS_REPLAY_MODEL");
  const system = env("NEATROOTS_REPLAY_SYSTEM_PROMPT");
  if (model) out.model = model;
  if (system) out.system = system;
  return out;
}

type Override = (p: Record<string, unknown>, o: { model?: string; system?: string }) => Record<string, unknown>;

const overrideChat: Override = (p, o) => {
  const next = { ...p };
  if (o.model) next.model = o.model;
  if (o.system) {
    const msgs = [...((p.messages as Msg[]) ?? [])];
    const i = msgs.findIndex((m) => m.role === "system" || m.role === "developer");
    if (i >= 0) msgs[i] = { ...msgs[i], content: o.system };
    else msgs.unshift({ role: "system", content: o.system });
    next.messages = msgs;
  }
  return next;
};
const overrideResponses: Override = (p, o) => ({ ...p, ...(o.model ? { model: o.model } : {}), ...(o.system ? { instructions: o.system } : {}) });
const overrideAnthropic: Override = (p, o) => ({ ...p, ...(o.model ? { model: o.model } : {}), ...(o.system ? { system: o.system } : {}) });

// --------------------------------------------------------------------- wrap

function wrapMethod(
  owner: Record<string, unknown> | undefined,
  name: string,
  transform: (args: Record<string, unknown>, note: Note) => Record<string, unknown>,
  override: Override = (p) => p,
): void {
  if (!owner) return;
  const original = owner[name] as ((...a: unknown[]) => unknown) & { __neatroots?: boolean };
  if (typeof original !== "function" || original.__neatroots) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const request = (async () => {
      const o = replayOverrides();
      const params = o.model || o.system ? override((args[0] ?? {}) as Record<string, unknown>, o) : ((args[0] ?? {}) as Record<string, unknown>);
      let next = params;
      try {
        const note = await guidance();
        if (note) next = transform({ ...params }, note);
      } catch (err) {
        if (err instanceof NeatrootsHalt) throw err;
      }
      // Box the SDK promise so awaiting guidance does not parse the provider response.
      return { value: original.apply(owner, [next, ...args.slice(1)]) };
    })();
    return new SteeredRequest(request);
  } as typeof original;
  wrapped.__neatroots = true;
  owner[name] = wrapped;
}

/** Wraps a method that builds a new client (`withOptions`) so the copy is wrapped too. */
function wrapFactory(owner: Record<string, unknown> | undefined, name: string, wrap: (next: object) => unknown): void {
  if (!owner) return;
  const original = owner[name] as ((...a: unknown[]) => unknown) & { __neatroots?: boolean };
  if (typeof original !== "function" || original.__neatroots) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return wrap(original.apply(owner, args) as object);
  } as typeof original;
  wrapped.__neatroots = true;
  owner[name] = wrapped;
}

/** Adds neatroots guidance to an OpenAI client (chat.completions.create/parse, responses.create/parse and withOptions), in place. */
export function wrapOpenAI<T extends object>(client: T): T {
  const c = client as unknown as { chat?: { completions?: Record<string, unknown> }; responses?: Record<string, unknown> };
  wrapMethod(c.chat?.completions, "create", (p, note) => {
    const msgs = (p.messages as Msg[]) ?? [];
    const last = msgs[msgs.length - 1];
    const next = last?.role === "user" ? [...msgs.slice(0, -1), appendText(last, guidanceBlock(note))] : [...msgs, { role: "user", content: guidanceBlock(note) }];
    return { ...p, messages: next };
  }, overrideChat);
  wrapMethod(c.responses, "create", (p, note) => {
    const input = p.input;
    if (typeof input === "string") return { ...p, input: `${input}\n\n${guidanceBlock(note)}` };
    if (Array.isArray(input)) return { ...p, input: [...input, { role: "user", content: guidanceBlock(note) }] };
    return p;
  }, overrideResponses);
  wrapFactory(client as unknown as Record<string, unknown>, "withOptions", (next) => wrapOpenAI(next));
  return client;
}

/** Adds neatroots guidance to an Anthropic client (messages.create and withOptions), in place. */
export function wrapAnthropic<T extends object>(client: T): T {
  const c = client as unknown as { messages?: Record<string, unknown> };
  wrapMethod(c.messages, "create", (p, note) => {
    const msgs = (p.messages as Msg[]) ?? [];
    const last = msgs[msgs.length - 1];
    const next = last?.role === "user" ? [...msgs.slice(0, -1), appendText(last, guidanceBlock(note))] : [...msgs, { role: "user", content: [{ type: "text", text: guidanceBlock(note) }] }];
    return { ...p, messages: next };
  }, overrideAnthropic);
  wrapFactory(client as unknown as Record<string, unknown>, "withOptions", (next) => wrapAnthropic(next));
  return client;
}

/**
 * Vercel AI SDK middleware: `wrapLanguageModel({ model, middleware: rootsMiddleware() })`.
 * Adds the pending note as a final user message in the call's prompt. AI SDK 7 uses
 * middleware spec "v4" (the default); pass "v3" for AI SDK 6.
 */
export function rootsMiddleware<V extends "v3" | "v4" = "v4">(version?: V) {
  return {
    specificationVersion: (version ?? "v4") as V,
    // Typed loosely so it fits the middleware types of several AI SDK versions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transformParams: async ({ params }: { params: any }): Promise<any> => {
      const note = await guidance();
      if (!note) return params;
      return { ...params, prompt: [...params.prompt, { role: "user", content: [{ type: "text", text: guidanceBlock(note) }] }] };
    },
  };
}

// --------------------------------------------------------------- self-check

export const CHECK_MY_WORK_DESCRIPTION =
  "Ask neatroots, a local checker that watches this run, a yes/no question about your own work so far (for example: 'Did I confirm the customer owns the order before refunding?'). Returns the probability that the answer is yes, judged from this run's recorded steps.";

export const CHECK_MY_WORK_PARAMETERS = {
  type: "object",
  properties: { question: { type: "string", description: "A yes/no question about this run so far." } },
  required: ["question"],
} as const;

/** OpenAI tool definition. */
export const CHECK_MY_WORK_TOOL = {
  type: "function" as const,
  function: { name: "check_my_work", description: CHECK_MY_WORK_DESCRIPTION, parameters: CHECK_MY_WORK_PARAMETERS },
};

/** Anthropic tool definition. */
export const ANTHROPIC_CHECK_MY_WORK_TOOL = { name: "check_my_work", description: CHECK_MY_WORK_DESCRIPTION, input_schema: CHECK_MY_WORK_PARAMETERS };

export interface CheckResult {
  answer: "yes" | "no" | "unknown";
  probability_yes: number | null;
  evidence_span_ids: string[];
  reason?: string;
}

/** Asks neatroots a yes/no question about the current run. */
export async function checkMyWork(question: string, opts: { traceId?: string; timeoutMs?: number } = {}): Promise<CheckResult> {
  const traceId = opts.traceId ?? (await currentTrace())[0];
  if (!traceId) return { answer: "unknown", probability_yes: null, evidence_span_ids: [], reason: "no active trace; is the Neatlogs SDK initialized?" };
  await flushSdk();
  const res = await post<{ answer?: string; probability?: number | null; evidence_span_ids?: string[]; reason?: string }>("/api/steer/check", { trace_id: traceId, question }, opts.timeoutMs ?? 30_000);
  if (!res) return { answer: "unknown", probability_yes: null, evidence_span_ids: [], reason: "neatroots is not reachable" };
  return {
    answer: (res.answer as CheckResult["answer"]) ?? "unknown",
    probability_yes: res.probability ?? null,
    evidence_span_ids: res.evidence_span_ids ?? [],
    reason: res.reason,
  };
}

/** If `name` is check_my_work, runs it and returns the JSON string to send back; otherwise undefined. */
export async function handleToolCall(name: string, args: unknown): Promise<string | undefined> {
  if (name !== "check_my_work") return undefined;
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a || "{}");
    } catch {
      a = { question: a };
    }
  }
  return JSON.stringify(await checkMyWork(String((a as { question?: string })?.question ?? "")));
}
