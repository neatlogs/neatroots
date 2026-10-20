import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as neatlogs from "neatlogs";
import { wrapOpenAI, wrapAnthropic, configure, type RequestTelemetry } from "../src/index.js";
import { buildView } from "../../neatroots/src/semantics/view.js";
import { buildChat } from "../../neatroots/src/semantics/chat-view.js";
import type { AnyValue, OtlpSpan } from "../../neatroots/src/otlp/types.js";
import type { SpanInfo } from "../../neatroots/src/engine/trace.js";
import { fixture } from "./sdk-fixture.js";
import { partialEvents, completeEvents, type API } from "./stream-events.js";

let local: Awaited<ReturnType<typeof fixture>>;
let exporter: neatlogs.Client;
const spans: any[] = [];
beforeAll(async () => {
  local = await fixture();
  exporter = new neatlogs.Client({ workflowName: "stream-fidelity", apiKey: "local", endpoint: local.url, uploadAuthority: false,
    spanExporter: { export(batch, done) { spans.push(...batch); done({ code: 0 }); }, async shutdown() {} } });
});
afterAll(async () => { await exporter?.close(); await local?.close(); });
beforeEach(() => { spans.length = 0; local.requests.length = 0; configure({ disabled: true, neatlogs }); });
const options = () => ({ apiKey: "local", baseURL: local.url, maxRetries: 0 });
const params = { model: "local", messages: [{ role: "user" as const, content: "hello" }], stream: true as const };
function request(api: API) {
  if (api === "chat") return wrapOpenAI(new OpenAI(options()), { telemetry: neatlogs }).chat.completions.create(params);
  if (api === "responses") return wrapOpenAI(new OpenAI(options()), { telemetry: neatlogs }).responses.create({ model: "local", input: "hi", stream: true });
  return wrapAnthropic(new Anthropic(options()), { telemetry: neatlogs }).messages.create({ ...params, max_tokens: 20 });
}
function any(value: unknown): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(any) } };
  return {};
}
function readback() {
  const llms = spans.filter((s) => s.attributes["neatlogs.span.kind"] === "llm");
  expect(llms).toHaveLength(1);
  const s = llms[0];
  const otlp: OtlpSpan = { traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentSpanId: "root", name: s.name, kind: 1,
    startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: any(v) })), events: [], links: [], status: s.status };
  const view = buildView(otlp, []);
  const root: SpanInfo = { id: "root", ref: "root", parentId: null, name: "agent", kind: "AGENT", startMs: 0, endMs: 1, durationMs: 1, status: "ok", seq: 0 };
  const child: SpanInfo = { ...root, id: otlp.spanId, parentId: "root", ref: "child", name: otlp.name, kind: view.kind, input: view.input, output: view.output, toolCalls: view.toolCalls, seq: 1 };
  const chat = buildChat({ traceId: otlp.traceId, run: undefined, spans: [root, child] });
  return { span: s, view, reply: chat.items.find((i) => i.type === "assistant")! };
}

it.each<API>(["chat", "responses", "anthropic"])("exports %s streamed text and tools through semantic/chat readers", async (api) => {
  const events = completeEvents(api);
  local.setEvents(events);
  const received: unknown[] = [];
  await exporter.activate(async () => { for await (const event of await request(api)) received.push(event); });
  await exporter.flush();
  expect(received).toEqual(events);
  expect(local.requests).toHaveLength(1);
  const { view, reply, span } = readback();
  expect(JSON.stringify(view.output)).toContain("Hello");
  expect(reply).toMatchObject({ type: "assistant", text: "Hello\nAlt", tool_calls: [{ name: "lookup", arguments: { id: 7 } }, { name: "log", arguments: { ok: true } }] });
  expect(view.promptTokens).toBe(3);
  expect(view.completionTokens).toBe(2);
  expect(span.attributes["neatroots.stream.event_count"]).toBe(events.length);
  expect(span.attributes["neatroots.stream.termination"]).toBe("eof");
});

it.each<API>(["chat", "responses", "anthropic"])("retains %s partial text and arguments when the provider errors", async (api) => {
  const prefix = partialEvents(api);
  local.setEvents([...prefix, { type: "error", error: { type: "api_error", message: "stream failure" } }]);
  const received: unknown[] = [];
  await exporter.activate(async () => {
    await expect((async () => { for await (const event of await request(api)) received.push(event); })()).rejects.toThrow(/stream failure/);
  });
  await exporter.flush();
  expect(received).toEqual(prefix);
  const { reply, span } = readback();
  expect(reply).toMatchObject({ type: "assistant", text: "Hello", tool_calls: [{ name: "lookup", arguments: '{"id":' }] });
  expect(span.status.code).toBe(2);
  expect(span.attributes["neatroots.stream.termination"]).not.toBe("eof");
});

it.each((["chat", "responses", "anthropic"] as API[]).flatMap((api) => ["cancel", "close"].map((end) => ({ api, end }))))("retains $api partial output on $end", async ({ api, end }) => {
  const prefix = partialEvents(api);
  local.setEvents([...prefix, ...completeEvents(api)]);
  await exporter.activate(async () => {
    const stream = await request(api), iterator = stream[Symbol.asyncIterator]();
    for (let i = 0; i < prefix.length; i++) expect((await iterator.next()).done).toBe(false);
    if (end === "cancel") stream.controller.abort();
    await iterator.return?.(undefined);
  });
  await exporter.flush();
  const { reply, span } = readback();
  expect(reply).toMatchObject({ type: "assistant", text: "Hello", tool_calls: [{ name: "lookup", arguments: '{"id":' }] });
  expect(span.status.code).toBe(2);
  expect(span.attributes["neatroots.stream.event_count"]).toBe(prefix.length);
  expect(["cancelled", "closed"]).toContain(span.attributes["neatroots.stream.termination"]);
});

it.each(["adding", "replacing", "removing"])("honors explicit options when %s telemetry on our own facade", async (change) => {
  let first = 0, second = 0;
  const a: RequestTelemetry = { trace: (options, fn) => { first++; return neatlogs.trace(options, fn); } };
  const b: RequestTelemetry = { trace: (options, fn) => { second++; return neatlogs.trace(options, fn); } };
  const raw = new OpenAI(options()), original = raw.chat.completions.create;
  const prior = wrapOpenAI(raw, change === "adding" ? undefined : { telemetry: a });
  const config = change === "removing" ? {} : { telemetry: b };
  const next = wrapOpenAI(prior, config);
  expect(wrapOpenAI(next, config)).toBe(next);
  await exporter.activate(async () => { await next.chat.completions.create({ model: "local", messages: [] }); });
  await exporter.flush();
  expect(first).toBe(0);
  expect(second).toBe(change === "removing" ? 0 : 1);
  expect(local.requests).toHaveLength(1);
  expect(raw.chat.completions.create).toBe(original);
});

it("records the real chat.completions.stream finalChatCompletion helper", async () => {
  local.setEvents(completeEvents("chat").map((e) => ({ created: 1, model: "local", ...(e as object) })));
  await exporter.activate(async () => {
    const client = wrapOpenAI(new OpenAI(options()), { telemetry: neatlogs });
    const result = await client.chat.completions.stream({ model: "local", messages: [] }).finalChatCompletion();
    expect(result.choices[0].message.content).toBe("Hello");
    expect(result.choices[0].message.tool_calls?.[0]).toMatchObject({ id: "call_a", function: { name: "lookup", arguments: '{"id":7}' } });
  });
  await exporter.flush();
  expect(local.requests).toHaveLength(1);
  expect(readback().reply).toMatchObject({ type: "assistant", text: "Hello\nAlt", tool_calls: [{ name: "lookup", arguments: { id: 7 } }, { name: "log", arguments: { ok: true } }] });
});

it("records the real responses.stream finalResponse helper", async () => {
  const response = { id: "resp_helper", object: "response", created_at: 1, model: "local", status: "completed", error: null, incomplete_details: null,
    output: [
      { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
      { type: "function_call", id: "fc", call_id: "call_a", name: "lookup", arguments: '{"id":7}', status: "completed" },
    ], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
  local.setEvents([
    { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
    { type: "response.completed", sequence_number: 1, response },
  ]);
  await exporter.activate(async () => {
    const client = wrapOpenAI(new OpenAI(options()), { telemetry: neatlogs });
    const result = await client.responses.stream({ model: "local", input: "hi" }).finalResponse();
    expect(result.id).toBe("resp_helper");
    expect(result.output).toMatchObject(response.output);
  });
  await exporter.flush();
  expect(local.requests).toHaveLength(1);
  expect(readback().reply).toMatchObject({ type: "assistant", text: "Hello", tool_calls: [{ name: "lookup", arguments: { id: 7 } }] });
});

it("serializes accumulated output only at terminal boundaries, independent of chunk count", async () => {
  let publications = 0;
  const telemetry: RequestTelemetry = { trace: (options, fn) => neatlogs.trace(options, (span) => fn(new Proxy(span, {
    get(target, key) {
      if (key === "setAttribute") return (name: string, value: string | number | boolean) => {
        if (name === "gen_ai.output.messages") publications++;
        return target.setAttribute(name, value);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }))) };
  local.setEvents([
    ...Array.from({ length: 200 }, () => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x" } }] })),
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  await exporter.activate(async () => {
    const stream = await wrapOpenAI(new OpenAI(options()), { telemetry }).chat.completions.create(params);
    for await (const _ of stream) { /* consume once */ }
  });
  await exporter.flush();
  expect(publications).toBeGreaterThan(0);
  expect(publications).toBeLessThanOrEqual(2);
  expect(readback().reply).toMatchObject({ type: "assistant", text: "x".repeat(200) });
});
