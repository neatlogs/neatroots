import { afterEach, describe, expect, it } from "vitest";
import { loadTrace, selectSpans } from "../src/engine/trace.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let tb: TestRoots | undefined;
afterEach(async () => { await tb?.close(); tb = undefined; });

describe.each(["boolValue", "bool_value"])("stream cancellation via collector %s", (key) => {
  it.each([
    { label: "abandoned UNSET", flag: true, status: 0, expected: true },
    { label: "abandoned OK", flag: true, status: 1, expected: true },
    { label: "completed", flag: false, status: 1, expected: false },
    { label: "failed", flag: true, status: 2, expected: true },
    { label: "string false", flag: "false", status: 0, expected: undefined },
    { label: "string true", flag: "true", status: 0, expected: undefined },
    { label: "number one", flag: 1, status: 0, expected: undefined },
    { label: "number zero", flag: 0, status: 0, expected: undefined },
    { label: "null", flag: null, status: 0, expected: undefined },
    { label: "missing", flag: undefined, status: 0, expected: undefined },
  ])("checks $label through /v1/traces without coercion", async ({ flag, status, expected }) => {
    tb = await makeRoots({ serve: true });
    const traceId = hex(16);
    const root = span({ traceId, name: "workflow", kind: "workflow" });
    const call = span({ traceId, parent: root.spanId, name: "stream", kind: "llm", status });
    const b = batch([call, root]);
    const attributes = [...call.attributes, ...(flag === undefined ? [] : [{ key: "neatlogs.stream.cancelled", value: { [key]: flag } }])];
    const payload = { resourceSpans: [{ resource: b.resource, scopeSpans: [{ scope: b.scope, spans: [{ ...call, attributes }, root] }] }] };
    const original = structuredClone(payload);
    const response = await fetch(tb.url + "/v1/traces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    await tb.roots.engine!.waitIdle(traceId, 5000);
    const snapshot = loadTrace(tb.roots.store, traceId);
    expect(snapshot.spans.find((s) => s.id === call.spanId)!.streamCancelled).toBe(expected);
    for (const filter of [true, false]) {
      expect(selectSpans(snapshot.spans, { stream_cancelled: filter }).map((s) => s.id)).toEqual(expected === filter ? [call.spanId] : []);
    }
    const findings = tb.roots.store.findingsForTrace(traceId);
    const abandoned = findings.find((f) => f.check_id === "stream-abandoned");
    expect(!!abandoned).toBe(expected === true && status !== 2);
    if (abandoned) expect(abandoned.evidence_span_ids).toEqual([call.spanId]);
    expect(findings.some((f) => f.check_id === "llm-call-failed")).toBe(status === 2);
    const stored = tb.roots.store.getOtlpSpan(traceId, call.spanId)!.span;
    expect(stored.attributes).toEqual([...call.attributes, ...(flag === undefined ? [] : [{
      key: "neatlogs.stream.cancelled", value: typeof flag === "boolean" ? { boolValue: flag } : {},
    }])]);
    expect(payload).toEqual(original);
  });
});
