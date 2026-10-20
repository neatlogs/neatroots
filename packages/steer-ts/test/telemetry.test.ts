import { expect, it, vi } from "vitest";
import { instrumentRequest, type RequestTelemetry } from "../src/telemetry.js";

const telemetryError = new Error("telemetry failed");
const span = { setAttribute() { throw telemetryError; } };
const adapters: [string, RequestTelemetry][] = [
  ["synchronous throw", { trace() { throw telemetryError; } }],
  ["rejection", { trace() { return Promise.reject(telemetryError); } }],
  ["missing callback", { trace() { return new Promise(() => {}); } }],
  ["throwing attributes", { trace: async (_options, fn) => fn(span) }],
  ["rejection after callback", { trace(_options, fn) { void Promise.resolve(fn(span)).catch(() => {}); return Promise.reject(telemetryError); } }],
];
async function bounded<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider suppressed by telemetry")), 100);
    })]);
  } finally { clearTimeout(timer!); }
}
function raw(read: () => unknown, response = new Response("body", { headers: { "x-request-id": "req-1" } })) {
  return {
    then<TResult1 = unknown, TResult2 = never>(
      yes?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      no?: ((error: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> { return Promise.resolve().then(read).then(yes, no); },
    asResponse: async () => response,
    withResponse: async () => ({ data: read(), response, request_id: "req-1" }),
    _thenUnwrap: () => { throw new Error("unused"); },
  };
}
it.each(adapters)("preserves provider success and metadata with %s", async (_name, telemetry) => {
  const data = { usage: { total_tokens: 5 }, result: "ok" };
  const response = new Response("body", { headers: { "x-request-id": "req-1" } });
  const invoke = vi.fn(() => raw(() => data, response));
  const { value } = await bounded(instrumentRequest(telemetry, "openai", "chat", {}, invoke));
  const request = value as ReturnType<typeof raw>;
  expect(await bounded(request.asResponse())).toBe(response);
  expect(response.bodyUsed).toBe(false);
  expect(await bounded(request.withResponse())).toEqual({ data, response, request_id: "req-1" });
  expect(await bounded(request)).toBe(data);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each(adapters)("preserves provider errors with %s", async (_name, telemetry) => {
  const error = new Error("provider failed");
  const invoke = vi.fn(() => raw(() => { throw error; }));
  const result = bounded(instrumentRequest(telemetry, "openai", "chat", {}, invoke)).then(({ value }) => value);
  await expect(bounded(result)).rejects.toBe(error);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each(adapters)("preserves provider construction errors with %s", async (_name, telemetry) => {
  const error = new Error("provider construction failed");
  const invoke = vi.fn(() => { throw error; });
  await expect(bounded(instrumentRequest(telemetry, "openai", "chat", {}, invoke))).rejects.toBe(error);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("preserves stream chunks and terminal error when attribute writes throw", async () => {
  const chunk = { usage: { total_tokens: 1 }, choices: [{ index: 0, delta: { content: "hello" } }] };
  const error = new Error("stream failed");
  const stream = { async *[Symbol.asyncIterator]() { yield chunk; throw error; } };
  const { value } = await instrumentRequest(adapters[3][1], "openai", "chat", {}, () => raw(() => stream));
  const observed = await (value as PromiseLike<AsyncIterable<unknown>>);
  const received: unknown[] = [];
  await expect((async () => { for await (const item of observed) received.push(item); })()).rejects.toBe(error);
  expect(received).toEqual([chunk]);
});
it.each(["late", "multiple"])("invokes the provider once with %s callbacks", async (timing) => {
  let callback!: (span: unknown) => unknown;
  const telemetry: RequestTelemetry = { trace(_options, fn) {
    callback = fn;
    if (timing === "multiple") { void Promise.resolve(fn(span)).catch(() => {}); void Promise.resolve(fn(span)).catch(() => {}); }
    return new Promise(() => {});
  } };
  const invoke = vi.fn(() => raw(() => "ok"));
  const { value } = await bounded(instrumentRequest(telemetry, "openai", "chat", {}, invoke));
  void Promise.resolve(callback(span)).catch(() => {});
  void Promise.resolve(callback(span)).catch(() => {});
  expect(await bounded(value as PromiseLike<unknown>)).toBe("ok");
  expect(invoke).toHaveBeenCalledTimes(1);
});
