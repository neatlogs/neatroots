import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, wrapOpenAI } from "../src/index.js";
import { SteeredRequest } from "../src/request.js";

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
});

function sdkRequest(read: () => unknown, response = new Response("ok")) {
  const props = { response, options: {}, controller: new AbortController() };
  const request = {
    then: vi.fn((fulfilled: (value: unknown) => unknown, rejected?: (reason: unknown) => unknown) =>
      Promise.resolve().then(read).then(fulfilled, rejected)),
    asResponse: vi.fn(async () => response),
    withResponse: vi.fn(async () => ({ data: read(), response, request_id: "req_test" })),
    _thenUnwrap: vi.fn(function (this: unknown, transform: (data: unknown, props: unknown) => unknown): unknown {
      expect(this).toBe(request);
      return sdkRequest(() => transform(read(), props), response);
    }),
  };
  return request;
}

describe("OpenAI parse helpers", () => {
  it.each(["chat", "responses"])("keeps %s parse requests lazy and preserves response helpers", async (api) => {
    const data = { refunded: true };
    const response = new Response("ok");
    const read = vi.fn(() => data);
    const original = sdkRequest(read, response);
    const create = vi.fn((_params: unknown, _options: unknown) => original);
    const owner = {
      create,
      parse(params: unknown, options: unknown) {
        return (this.create(params, options) as unknown as SteeredRequest)._thenUnwrap((value) => ({ parsed: value }));
      },
    };
    wrapOpenAI(api === "chat" ? { chat: { completions: owner } } : { responses: owner });
    const params = { model: "test", messages: [], input: "hi" };
    const options = { headers: { "x-test": "local" } };
    const request = owner.parse(params, options);
    expect(read).not.toHaveBeenCalled();
    expect(await request.asResponse()).toBe(response);
    expect(read).not.toHaveBeenCalled();
    expect(await request.withResponse()).toEqual({ data: { parsed: data }, response, request_id: "req_test" });
    expect(await request).toEqual({ parsed: data });
    expect(create).toHaveBeenCalledExactlyOnceWith(params, options);
    expect(original.then).not.toHaveBeenCalled();
    expect(original._thenUnwrap).toHaveBeenCalledOnce();
  });

  it("forwards response props and supports chained transforms", async () => {
    const response = new Response("ok");
    const original = sdkRequest(() => 2, response);
    const transform = vi.fn((value: unknown, props: unknown) => ({ value, props }));
    const request = new SteeredRequest(Promise.resolve({ value: original }))._thenUnwrap(transform);
    expect(await request._thenUnwrap((value) => ({ wrapped: value }))).toMatchObject({
      wrapped: { value: 2, props: { response } },
    });
    expect(transform).toHaveBeenCalledOnce();
  });

  it("rejects without transforming when guidance fails", async () => {
    const error = new Error("guidance stopped the request");
    const transform = vi.fn();
    const request = new SteeredRequest(Promise.reject(error))._thenUnwrap(transform);
    await expect(request).rejects.toBe(error);
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(["request", "transform"])("preserves %s failures", async (stage) => {
    const error = new Error(stage);
    const original = sdkRequest(() => {
      if (stage === "request") throw error;
      return "ok";
    });
    const request = new SteeredRequest(Promise.resolve({ value: original }))._thenUnwrap(() => { throw error; });
    await expect(request).rejects.toBe(error);
  });
});
