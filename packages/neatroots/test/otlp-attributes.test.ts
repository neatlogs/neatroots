import { afterEach, describe, expect, it } from "vitest";
import { hex, makeRoots, type TestRoots } from "./helpers.js";

// Attributes sent as an object instead of a list used to be accepted with a 200 and stored as
// nothing: the span lost its kind, model and every other attribute, and the sender saw no error.

let tb: TestRoots | undefined;
afterEach(async () => {
  await tb?.close();
  tb = undefined;
});

const now = String(BigInt(Date.now()) * 1_000_000n);
const post = (path: string, body: unknown) =>
  fetch(`${tb!.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const traces = (traceId: string, attributes: unknown) => ({
  resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId, spanId: hex(8), name: "op", kind: 1, startTimeUnixNano: now, endTimeUnixNano: now, attributes }] }] }],
});

describe("OTLP/JSON attributes that aren't a list", () => {
  it("are answered with a 400 on /v1/traces and nothing is stored", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const t = hex(16);
    const r = await post("/v1/traces", traces(t, { "gen_ai.request.model": "gpt-4o", "neatlogs.span.kind": "llm" }));
    expect(r.status).toBe(400); // was 200
    expect(((await r.json()) as { message: string }).message).toMatch(/attributes must be an array/);
    expect(tb.roots.store.getRun(t)).toBeUndefined();
  });

  it("are answered with a 400 on /v1/logs", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const r = await post("/v1/logs", { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "x" }, logRecords: [{ timeUnixNano: now, body: { stringValue: "hi" }, attributes: { a: "b" } }] }] }] });
    expect(r.status).toBe(400); // was 200
  });

  it("still accepts a span that leaves attributes out", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const t = hex(16);
    expect((await post("/v1/traces", traces(t, undefined))).status).toBe(200);
    expect(tb.roots.store.getRun(t)).toBeDefined();
  });
});
