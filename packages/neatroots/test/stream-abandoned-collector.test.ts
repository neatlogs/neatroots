import { afterEach, describe, expect, it } from "vitest";
import { loadTrace, selectSpans } from "../src/engine/trace.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let tb: TestRoots | undefined;
afterEach(async () => { await tb?.close(); tb = undefined; });

describe.each(["boolValue", "bool_value"])("stream cancellation via collector %s", (key) => {
  it.each([
    { label: "abandoned UNSET", flag: true, status: 0, expected: true },
    { label: "abandoned OK", flag: true, status: 1, expected: true },
    { label: "completed", flag: false, status: 1, expected: false },
    { label: "failed", flag: true, status: 2, expected: true },
    { label: "missing", flag: undefined, status: 0, expected: undefined },
  ])("checks $label through /v1/traces with unchanged codec behavior", async ({ flag, status, expected }) => {
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
      key: "neatlogs.stream.cancelled", value: { boolValue: flag },
    }])]);
    expect(payload).toEqual(original);
  });
});

describe("stream cancellation with exception evidence", () => {
  it.each([
    { status: 0, event: "exception", message: "stream disconnected", abandoned: false },
    { status: 1, event: "exception", message: "stream disconnected", abandoned: false },
    { status: 2, event: "exception", message: "stream disconnected", abandoned: false },
    { status: 0, event: "exception", message: undefined, abandoned: false },
    { status: 0, event: "stream.chunk", message: "ordinary chunk", abandoned: true },
    { status: 0, event: undefined, message: undefined, abandoned: true },
  ])("status $status / $event / $message", async ({ status, event, message, abandoned }) => {
    tb = await makeRoots({ serve: true });
    const traceId = hex(16);
    const root = span({ traceId, name: "workflow", kind: "workflow" });
    const call = span({ traceId, parent: root.spanId, name: "stream", kind: "llm", status,
      attrs: [s("neatlogs.stream.cancelled", true)],
      events: event ? [{ name: event, timeUnixNano: root.startTimeUnixNano, attributes: message ? [s("exception.message", message)] : [s("exception.type", "StreamError")] }] : [],
    });
    const b = batch([call, root]);
    const response = await fetch(tb.url + "/v1/traces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ resource: b.resource, scopeSpans: [{ scope: b.scope, spans: b.spans }] }] }),
    });
    expect(response.status).toBe(200);
    await tb.roots.engine!.waitIdle(traceId, 5000);
    const snapshot = loadTrace(tb.roots.store, traceId);
    const observed = snapshot.spans.find((v) => v.id === call.spanId)!;
    expect(observed.status).toBe(status === 2 ? "error" : status === 1 ? "ok" : "unset");
    expect(!!observed.error).toBe(status === 2 || event === "exception");
    expect(observed.streamCancelled).toBe(true);
    for (const hasError of [true, false]) {
      expect(selectSpans(snapshot.spans, { type: "llm", has_error: hasError }).map((v) => v.id))
        .toEqual(Boolean(observed.error) === hasError ? [call.spanId] : []);
    }
    // Existing status:ok semantics include UNSET, even when exception evidence exists.
    expect(selectSpans(snapshot.spans, { type: "llm", status: "ok" }).map((v) => v.id)).toEqual(status === 2 ? [] : [call.spanId]);
    const findings = tb.roots.store.findingsForTrace(traceId);
    const hit = findings.find((f) => f.check_id === "stream-abandoned");
    expect(!!hit).toBe(abandoned);
    if (hit) expect(hit.evidence_span_ids).toEqual([call.spanId]);
    // The existing failed-call rule still classifies by explicit ERROR status.
    expect(findings.some((f) => f.check_id === "llm-call-failed")).toBe(status === 2);
    expect(tb.roots.store.getOtlpSpan(traceId, call.spanId)!.span).toEqual(call);
  });
});
