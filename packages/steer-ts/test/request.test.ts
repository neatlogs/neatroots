import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, wrapOpenAI } from "../src/index.js";

beforeEach(() => configure({ disabled: true }));
afterEach(() => configure({ disabled: false }));

describe("OpenAI request helpers", () => {
  it.each(["chat", "responses"])("forwards helpers on %s requests with the original receiver and options", async (api) => {
    const response = new Response("ok");
    const sdkRequest = Object.assign(Promise.resolve("ok"), {
      asResponse: vi.fn(async function (this: unknown) {
        expect(this).toBe(sdkRequest);
        return response;
      }),
      withResponse: vi.fn(async function (this: unknown) {
        expect(this).toBe(sdkRequest);
        return { data: "ok", response };
      }),
    });
    const create = vi.fn(function (this: unknown, _params: unknown, _options: unknown) {
      expect(this).toBe(owner);
      return sdkRequest;
    });
    const owner = { create };
    wrapOpenAI(api === "chat" ? { chat: { completions: owner } } : { responses: owner });
    const params = { model: "test", messages: [{ role: "user", content: "hi" }], input: "hi" };
    const options = { headers: { "x-test": "local" } };
    const request = owner.create(params, options);
    expect(await request.asResponse()).toBe(response);
    expect(await request.withResponse()).toEqual({ data: "ok", response });
    expect(await request).toBe("ok");
    expect(create).toHaveBeenCalledExactlyOnceWith(params, options);
  });

  it("keeps the _thenUnwrap step of openai-node's parse() helpers, and their response helpers", async () => {
    const response = new Response("ok");
    const sdkRequest = Object.assign(Promise.resolve({ text: "raw" }), {
      asResponse: vi.fn(async () => response),
      withResponse: vi.fn(async () => ({ data: { text: "raw" }, response })),
    });
    const owner = { create: vi.fn((_params: unknown) => sdkRequest) };
    wrapOpenAI({ chat: { completions: owner } });
    const request = owner.create({ model: "test" }) as unknown as {
      _thenUnwrap<T>(transform: (value: unknown) => T): unknown;
      asResponse(): Promise<Response>;
      withResponse(): Promise<{ data: unknown }>;
    };
    const parsed = request._thenUnwrap((value) => ({ ...(value as object), parsed: true })) as Promise<unknown> & {
      asResponse(): Promise<Response>;
      withResponse(): Promise<{ data: unknown }>;
    };
    expect(await parsed).toEqual({ text: "raw", parsed: true });
    expect(await parsed.asResponse()).toBe(response);
    expect(await parsed.withResponse()).toEqual({ data: { text: "raw", parsed: true }, response });
  });
});
