import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { zodResponseFormat, zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as neatlogs from "neatlogs";
import { configure, wrapOpenAI, wrapAnthropic } from "../src/index.js";
import { fixture } from "./sdk-fixture.js";

let local: Awaited<ReturnType<typeof fixture>>;
let exporter: neatlogs.Client;
const spans: any[] = [];
beforeAll(async () => {
  local = await fixture();
  exporter = new neatlogs.Client({ workflowName: "local-composition", apiKey: "local-fixture", endpoint: local.url, uploadAuthority: false, spanExporter: {
    export(batch, done) { spans.push(...batch); done({ code: 0 }); },
    async shutdown() {},
  } });
});
afterAll(async () => { await exporter?.close(); await local?.close(); });
beforeEach(() => { local.requests.length = 0; spans.length = 0; configure({ disabled: true, neatlogs }); });
afterEach(() => { delete process.env.NEATROOTS_REPLAY_MODEL; delete process.env.NEATROOTS_REPLAY_SYSTEM_PROMPT; });
const options = () => ({ apiKey: "fixture", baseURL: local.url, maxRetries: 0 });
const openai = () => wrapOpenAI(new OpenAI(options()), { telemetry: neatlogs });
const anthropic = () => wrapAnthropic(new Anthropic(options()), { telemetry: neatlogs });
const params = { model: "local", messages: [{ role: "user" as const, content: "hello" }] };
const llm = () => spans.filter((s) => String(s.attributes["neatlogs.span.kind"]).toLowerCase() === "llm");
async function run(fn: () => PromiseLike<unknown>) {
  await exporter.activate(fn);
  await exporter.flush();
}

it.each(["chat", "responses", "anthropic"])("preserves real %s create response, request options and one span", async (api) => {
  await run(async () => {
    const request = api === "chat" ? openai().chat.completions.create(params, { headers: { "x-fixture": "retained" } })
      : api === "responses" ? openai().responses.create({ model: "local", input: "hello" }, { headers: { "x-fixture": "retained" } })
      : anthropic().messages.create({ ...params, max_tokens: 9 }, { headers: { "x-fixture": "retained" } });
    const result = await request.withResponse();
    expect(result.response.status).toBe(201);
    expect(result.request_id).toBe("req_real");
    expect(result.data.id).toMatch(/local/);
  });
  expect(local.requests).toHaveLength(1);
  expect(local.requests[0].header).toBe("retained");
  expect(llm()).toHaveLength(1);
  expect(JSON.parse(llm()[0].attributes["neatlogs.llm.input"])).toEqual(local.requests[0].body);
});

it.each(["chat", "responses"])("preserves native %s structured parsing and response metadata", async (api) => {
  await run(async () => {
    if (api === "chat") {
      const r = await openai().chat.completions.parse({ ...params, response_format: zodResponseFormat(z.object({ ok: z.boolean() }), "answer") }).withResponse();
      expect(r.data.choices[0].message.parsed).toEqual({ ok: true });
      expect(r.request_id).toBe("req_real");
    } else {
      const r = await openai().responses.parse({ model: "local", input: "hello", text: { format: zodTextFormat(z.object({ ok: z.boolean() }), "answer") } }).withResponse();
      expect(r.data.output_parsed).toEqual({ ok: true });
      expect(r.request_id).toBe("req_real");
    }
  });
  expect(llm()).toHaveLength(1);
  expect(local.requests).toHaveLength(1);
});

it.each(["chat", "responses", "anthropic"])("keeps %s stream completion and usage", async (api) => {
  await run(async () => {
    if (api === "anthropic") {
      const stream = anthropic().messages.stream({ ...params, max_tokens: 9 });
      expect((await stream.finalMessage()).content).toEqual([{ type: "text", text: "OK" }]);
    } else {
      const stream = api === "chat" ? await openai().chat.completions.create({ ...params, stream: true })
        : await openai().responses.create({ model: "local", input: "hello", stream: true });
      const items = [];
      for await (const item of stream) items.push(item);
      expect(items.length).toBeGreaterThan(0);
    }
  });
  expect(local.requests).toHaveLength(1);
  expect(llm()).toHaveLength(1);
  expect(llm()[0].status.code).not.toBe(2);
  expect(llm()[0].attributes["neatlogs.llm.token_count.prompt"]).toBe(3);
  expect(llm()[0].attributes["neatlogs.llm.token_count.completion"]).toBe(2);
});

it.each(["chat", "responses", "anthropic"])("leaves %s raw response body unread", async (api) => {
  await run(async () => {
    const request = api === "chat" ? openai().chat.completions.create(params)
      : api === "responses" ? openai().responses.create({ model: "local", input: "hello" })
      : anthropic().messages.create({ ...params, max_tokens: 9 });
    const raw = await request.asResponse();
    expect(raw.status).toBe(201);
    expect(raw.headers.get("x-request-id")).toBe("req_real");
    expect(raw.bodyUsed).toBe(false);
    expect((await raw.json()).id).toMatch(/local/);
  });
  expect(llm()).toHaveLength(1);
});

it("records guidance and replay exactly as sent, once, without mutating inputs", async () => {
  configure({ disabled: false, url: local.url, traceId: () => "a".repeat(32), neatlogs: { ...neatlogs, flush: async () => true } });
  process.env.NEATROOTS_REPLAY_MODEL = "replayed";
  process.env.NEATROOTS_REPLAY_SYSTEM_PROMPT = "New system";
  await run(() => openai().chat.completions.create(params));
  expect(params.messages).toEqual([{ role: "user", content: "hello" }]);
  expect(local.requests[0].body.model).toBe("replayed");
  expect(local.requests[0].body.messages[1].content).toContain("Check once.");
  expect(llm()).toHaveLength(1);
  expect(JSON.parse(llm()[0].attributes["neatlogs.llm.input"])).toEqual(local.requests[0].body);
});

it("preserves provider errors and aborts without duplicate requests", async () => {
  await run(async () => {
    await expect(openai().chat.completions.create({ ...params, model: "reject" })).rejects.toMatchObject({ status: 400 });
    const control = new AbortController();
    const request = openai().chat.completions.create({ ...params, model: "wait" }, { signal: control.signal });
    const pending = expect(request).rejects.toThrow(/abort/i);
    setTimeout(() => control.abort(), 20);
    await pending;
  });
  expect(llm()).toHaveLength(2);
  expect(llm().every((s) => s.status.code === 2)).toBe(true);
  expect(local.requests.filter((r) => r.body.model === "reject")).toHaveLength(1);
});

it("does not mutate the raw client and wraps clones and repeated wrappers once", async () => {
  const raw = new OpenAI(options());
  const create = raw.chat.completions.create;
  const wrapped = wrapOpenAI(raw, { telemetry: neatlogs });
  expect(raw.chat.completions.create).toBe(create);
  expect(wrapOpenAI(wrapped)).toBe(wrapped);
  expect(wrapOpenAI(raw, { telemetry: neatlogs })).toBe(wrapped);
  expect(wrapped.chat.completions).toBe(wrapped.chat.completions);
  await run(() => wrapped.withOptions({ defaultHeaders: { "x-fixture": "clone" } }).chat.completions.create(params));
  expect(local.requests[0].header).toBe("clone");
  expect(llm()).toHaveLength(1);
});

it("retains the raw and individual-wrapper controls and reproduces opaque nesting", async () => {
  await run(async () => {
    await new OpenAI(options()).chat.completions.create(params);
    await wrapOpenAI(new OpenAI(options())).chat.completions.create(params);
    await neatlogs.wrapOpenAI(new OpenAI(options())).chat.completions.create(params);
    const opaque = neatlogs.wrapAnthropic(new Anthropic(options())).messages.create({ ...params, max_tokens: 9 });
    expect(typeof opaque.withResponse).toBe("undefined");
    await opaque;
  });
  expect(local.requests.length).toBeGreaterThanOrEqual(3);
});

it("preserves independent concurrent calls and Anthropic clones", async () => {
  const client = anthropic();
  await run(async () => {
    await Promise.all([
      client.withOptions({ defaultHeaders: { "x-fixture": "one" } }).messages.create({ ...params, max_tokens: 8 }),
      client.withOptions({ defaultHeaders: { "x-fixture": "two" } }).messages.create({ ...params, max_tokens: 8 }),
    ]);
  });
  expect(local.requests.map((r) => r.header).sort()).toEqual(["one", "two"]);
  expect(llm()).toHaveLength(2);
});

it("ends stream telemetry on early return and controller cancellation", async () => {
  await run(async () => {
    const early = await openai().chat.completions.create({ ...params, stream: true });
    for await (const _ of early) break;
    const aborted = await openai().responses.create({ model: "local", input: "hello", stream: true });
    aborted.controller.abort();
  });
  expect(llm()).toHaveLength(2);
  // The SDK aborts its controller on early iterator return as well.
  expect(llm().filter((s) => s.status.code === 2)).toHaveLength(2);
});

it.each(["responses", "anthropic"])("preserves %s rejection and cancellation", async (api) => {
  const create = (model: string, signal?: AbortSignal) => api === "responses"
    ? openai().responses.create({ model, input: "hello" }, { signal })
    : anthropic().messages.create({ ...params, model, max_tokens: 9 }, { signal });
  await run(async () => {
    await expect(create("reject")).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController();
    controller.abort();
    await expect(create("local", controller.signal)).rejects.toThrow(/abort/i);
  });
  expect(llm()).toHaveLength(2);
  expect(llm().every((s) => s.status.code === 2)).toBe(true);
  expect(local.requests).toHaveLength(1);
});

const surfaces = ["chat.create", "chat.parse", "chat.stream", "responses.create", "responses.parse", "responses.stream", "anthropic.create", "anthropic.stream"] as const;
const modes = ["raw", "steering", "telemetry", "adapter"] as const;
it.each(modes.flatMap((mode) => surfaces.map((surface) => ({ mode, surface }))))(
  "compares $mode / $surface against one local provider call", async ({ mode, surface }) => {
    await run(async () => {
      const oa = new OpenAI(options());
      const an = new Anthropic(options());
      const o = mode === "raw" ? oa : mode === "steering" ? wrapOpenAI(oa) : mode === "telemetry" ? neatlogs.wrapOpenAI(oa) : wrapOpenAI(oa, { telemetry: neatlogs });
      const a = mode === "raw" ? an : mode === "steering" ? wrapAnthropic(an) : mode === "telemetry" ? neatlogs.wrapAnthropic(an) : wrapAnthropic(an, { telemetry: neatlogs });
      switch (surface) {
        case "chat.create": expect((await o.chat.completions.create(params)).id).toBe("chat_local"); break;
        case "chat.parse": expect((await o.chat.completions.parse({ ...params, response_format: zodResponseFormat(z.object({ ok: z.boolean() }), "answer") })).choices[0].message.parsed).toEqual({ ok: true }); break;
        case "responses.create": expect((await o.responses.create({ model: "local", input: "hi" })).id).toBe("resp_local"); break;
        case "responses.parse": expect((await o.responses.parse({ model: "local", input: "hi", text: { format: zodTextFormat(z.object({ ok: z.boolean() }), "answer") } })).output_parsed).toEqual({ ok: true }); break;
        case "anthropic.create": expect((await a.messages.create({ ...params, max_tokens: 8 })).id).toBe("msg_local"); break;
        case "anthropic.stream": expect((await a.messages.stream({ ...params, max_tokens: 8 }).finalMessage()).id).toBe("msg_local"); break;
        default: {
          const stream = surface === "chat.stream" ? await o.chat.completions.create({ ...params, stream: true }) : await o.responses.create({ model: "local", input: "hi", stream: true });
          let count = 0;
          for await (const _ of stream) count++;
          expect(count).toBeGreaterThan(0);
        }
      }
    });
    expect(local.requests).toHaveLength(1);
    // Public telemetry-only parse bypasses its create Proxy; the explicit adapter covers it.
    expect(llm()).toHaveLength(mode === "adapter" || (mode === "telemetry" && !surface.endsWith("parse")) ? 1 : 0);
  },
);

it("keeps one stream identity across repeated awaits", async () => {
  await run(async () => {
    const request = openai().chat.completions.create({ ...params, stream: true });
    const first = await request;
    expect(await request).toBe(first);
    for await (const _ of first) { /* finish the stream */ }
  });
  expect(local.requests).toHaveLength(1);
  expect(llm()).toHaveLength(1);
});

it.each(["chat-empty", "chat-missing", "anthropic-empty", "anthropic-missing"])("keeps claimed guidance for %s messages", async (variant) => {
  configure({ disabled: false, url: local.url, traceId: () => "a".repeat(32), neatlogs: { ...neatlogs, flush: async () => true } });
  const input = { model: "local", ...(variant.endsWith("empty") ? { messages: [] } : {}) };
  await run(async () => {
    if (variant.startsWith("chat")) await openai().chat.completions.create(input as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    else await anthropic().messages.create({ ...input, max_tokens: 8 } as Anthropic.MessageCreateParamsNonStreaming);
  });
  expect(local.requests).toHaveLength(1);
  const sent = local.requests[0].body;
  expect(sent.messages).toHaveLength(1);
  expect(sent.messages[0].role).toBe("user");
  expect(JSON.stringify(sent.messages[0].content)).toContain("Check once.");
  expect(llm()).toHaveLength(1);
  expect(JSON.parse(llm()[0].attributes["neatlogs.llm.input"])).toEqual(sent);
});
