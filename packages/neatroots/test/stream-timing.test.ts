import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { streamTiming } from "../src/semantics/stream-timing.js";
import type { OtlpEvent, OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

const start = 1_700_000_000_123_456_789n;
const ns = (ms: number) => String(start + BigInt(Math.round(ms * 1e6)));
const chunk = (index: number, ms: number, bytes = 0): OtlpEvent => ({
  name: "neatlogs.stream.chunk", timeUnixNano: ns(ms),
  attributes: [s("neatlogs.stream.chunk.index", index), s("neatlogs.stream.chunk.summary", JSON.stringify({ choices: [{ content_bytes: bytes, reasoning_bytes: 0, tool_fragments: 0 }] }))],
});
function call(p: Partial<OtlpSpan> = {}): OtlpSpan {
  return { ...span({ traceId: hex(16), name: "stream", kind: "llm" }), startTimeUnixNano: ns(0), endTimeUnixNano: ns(1000), ...p };
}
const timing = (p: Partial<OtlpSpan> = {}) => {
  const v = streamTiming(call(p));
  return [v.firstChunkMs, v.firstTextMs];
};

describe("streaming response timing", () => {
  it("separates empty, reasoning and tool chunks from visible text", () => {
    const reasoning = chunk(1, 350);
    reasoning.attributes[1] = s("neatlogs.stream.chunk.summary", JSON.stringify({ choices: [{ content_bytes: 0, reasoning_bytes: 10, tool_fragments: 1 }] }));
    expect(timing({ events: [chunk(0, 190), reasoning, chunk(2, 494, 5), chunk(3, 800, 10)] })).toEqual([190, 494]);
  });

  it("orders chunks by index rather than exporter array order", () => {
    expect(timing({ events: [chunk(2, 494, 5), chunk(0, 190), chunk(1, 350)] })).toEqual([190, 494]);
  });

  it("subtracts nanoseconds before converting to milliseconds", () => {
    expect(timing({ events: [chunk(0, 0.000123, 1)] })).toEqual([0.000123, 0.000123]);
  });

  it("preserves measured zero and permits unfinished spans", () => {
    expect(timing({ events: [chunk(0, 0, 1)], endTimeUnixNano: "0" })).toEqual([0, 0]);
  });

  it("keeps absent timing unknown, including non-streaming calls with output", () => {
    expect(timing({ attributes: [s("neatlogs.span.kind", "llm"), s("neatlogs.llm.output", "answer")] })).toEqual([undefined, undefined]);
  });

  it("does not call usage-only chunks visible text", () => {
    const e = chunk(0, 200);
    e.attributes[1] = s("neatlogs.stream.chunk.summary", JSON.stringify({ choices: [], usage: true }));
    expect(timing({ events: [e] })).toEqual([200, undefined]);
  });

  it("does not infer the first response from a capture missing chunk zero", () => {
    expect(timing({ events: [chunk(1, 400, 10)] })).toEqual([undefined, undefined]);
  });

  it("does not infer first text across a missing chunk", () => {
    expect(timing({ events: [chunk(0, 190), chunk(2, 494, 10)] })).toEqual([190, undefined]);
  });

  it("refuses duplicate chunk indices and regressing timestamps", () => {
    expect(timing({ events: [chunk(0, 190), chunk(0, 300, 10)] })).toEqual([undefined, undefined]);
    expect(timing({ events: [chunk(0, 300), chunk(1, 200, 10)] })).toEqual([300, undefined]);
  });

  it.each(["broken", "null", "[]", "{}", '{"choices":[null]}', '{"choices":[{"content_bytes":-1}]}', '{"choices":[{"content_bytes":"5"}]}'])
    ("does not infer text across malformed summary %s", (summary) => {
      const e = chunk(0, 190);
      e.attributes[1] = s("neatlogs.stream.chunk.summary", summary);
      expect(timing({ events: [e, chunk(1, 494, 10)] })).toEqual([190, undefined]);
    });

  it.each(["bad", "-1", "1.2", "Infinity"])("ignores invalid span time %s", (value) => {
    expect(timing({ startTimeUnixNano: value, events: [chunk(0, 200, 5)] })).toEqual([undefined, undefined]);
    expect(timing({ endTimeUnixNano: value, events: [chunk(0, 200, 5)] })).toEqual([undefined, undefined]);
  });

  it.each([-1, 1001])("ignores a first chunk outside the call at %s ms", (ms) => {
    expect(timing({ events: [chunk(0, ms, 5)] })).toEqual([undefined, undefined]);
  });

  it.each([-1, 0.5, NaN])("ignores invalid chunk index %s", (index) => {
    expect(timing({ events: [chunk(index, 200, 5)] })).toEqual([undefined, undefined]);
  });

  it("reads GenAI seconds as first-chunk milliseconds, without inventing first text", () => {
    expect(timing({ attributes: [s("neatlogs.span.kind", "llm"), s("gen_ai.response.time_to_first_chunk", 0.25)] })).toEqual([250, undefined]);
    expect(timing({ attributes: [s("neatlogs.span.kind", "llm"), s("gen_ai.response.time_to_first_chunk", 0)] })).toEqual([0, undefined]);
  });

  it.each([-1, 1.1, "0.2", true, Infinity])("rejects invalid GenAI duration %s", (value) => {
    expect(timing({ attributes: [s("neatlogs.span.kind", "llm"), s("gen_ai.response.time_to_first_chunk", value)] })).toEqual([undefined, undefined]);
  });

  it("rejects a seconds-to-milliseconds overflow on an unfinished call", () => {
    expect(timing({ endTimeUnixNano: "0", attributes: [s("neatlogs.span.kind", "llm"), s("gen_ai.response.time_to_first_chunk", 1e308)] })).toEqual([undefined, undefined]);
  });

  it("uses indexed chunk evidence when an attribute disagrees", () => {
    expect(timing({ attributes: [s("neatlogs.span.kind", "llm"), s("gen_ai.response.time_to_first_chunk", 0.8)], events: [chunk(0, 190), chunk(1, 494, 5)] })).toEqual([190, 494]);
  });
});

let roots: TestRoots | undefined;
afterEach(async () => { await roots?.close(); roots = undefined; });

it("returns timings through the real span API without changing stored OTLP", async () => {
  roots = await makeRoots({ noEngine: true });
  const original = call({ events: [chunk(0, 190), chunk(1, 494, 5)] });
  roots.roots.ingest([batch([original])]);
  const before = roots.roots.store.getOtlpSpan(original.traceId, original.spanId);
  const app = createApp(roots.roots);
  const response = await app.request(`/api/runs/${original.traceId}/spans/${original.spanId}`, { headers: { host: "localhost" } });
  expect(response.status).toBe(200);
  expect((await response.json()).view).toMatchObject({ firstChunkMs: 190, firstTextMs: 494 });
  expect(roots.roots.store.getOtlpSpan(original.traceId, original.spanId)).toEqual(before);
  expect(before?.span.events).toEqual(original.events);
  const tool = call({ attributes: [s("neatlogs.span.kind", "tool")], events: [chunk(0, 200, 5)] });
  roots.roots.ingest([batch([tool])]);
  const toolResponse = await app.request(`/api/runs/${tool.traceId}/spans/${tool.spanId}`, { headers: { host: "localhost" } });
  const view = (await toolResponse.json()).view;
  expect(view).not.toHaveProperty("firstChunkMs");
  expect(view).not.toHaveProperty("firstTextMs");
});
