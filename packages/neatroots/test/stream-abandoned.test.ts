import { afterEach, describe, expect, it } from "vitest";
import { buildView } from "../src/semantics/view.js";
import { loadTrace, selectSpans } from "../src/engine/trace.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let tb: TestRoots | undefined;
afterEach(async () => { await tb?.close(); tb = undefined; });

describe("SDK stream abandonment", () => {
  it.each([
    { label: "abandoned", flag: true, status: 0, abandoned: true, failed: false },
    { label: "completed", flag: false, status: 1, abandoned: false, failed: false },
    { label: "failed", flag: true, status: 2, abandoned: false, failed: true },
    { label: "missing telemetry", flag: undefined, status: 0, abandoned: false, failed: false },
    { label: "malformed telemetry", flag: "true", status: 0, abandoned: false, failed: false },
  ])("checks $label through the stored trace and shipped library", async ({ flag, status, abandoned, failed }) => {
    tb = await makeRoots();
    const traceId = hex(16);
    const root = span({ traceId, name: "workflow", kind: "workflow", attrs: [s("neatlogs.workflow.output", "Done")] });
    const call = span({ traceId, parent: root.spanId, name: "anthropic.messages.stream", kind: "llm", status,
      message: status === 2 ? "connection failed" : undefined,
      attrs: [s("neatlogs.llm.output", "partial reply"), ...(flag === undefined ? [] : [s("neatlogs.stream.cancelled", flag)])],
    });
    const original = structuredClone(call);
    tb.roots.ingest([batch([call, root])]);
    await tb.roots.engine!.waitIdle(traceId, 5000);
    const findings = tb.roots.store.findingsForTrace(traceId);
    const hit = findings.find((f) => f.check_id === "stream-abandoned");
    expect(!!hit).toBe(abandoned);
    if (hit) expect(hit.evidence_span_ids).toEqual([call.spanId]);
    expect(findings.some((f) => f.check_id === "llm-call-failed")).toBe(failed);
    expect(tb.roots.store.getOtlpSpan(traceId, call.spanId)!.span).toEqual(original);
    expect(call).toEqual(original);
    const snapshot = loadTrace(tb.roots.store, traceId);
    expect(snapshot.spans.find((v) => v.id === call.spanId)!.streamCancelled).toBe(typeof flag === "boolean" ? flag : undefined);
    expect(selectSpans(snapshot.spans, { stream_cancelled: false }).map((v) => v.id)).toEqual(flag === false ? [call.spanId] : []);
  });

  it("normalizes only boolean values without mutating the OTLP span", () => {
    for (const flag of [true, false, "true", "false", 1, 0]) {
      const call = span({ traceId: hex(16), name: "stream", kind: "llm", attrs: [s("neatlogs.stream.cancelled", flag)] });
      const original = structuredClone(call);
      expect(buildView(call, []).streamCancelled).toBe(typeof flag === "boolean" ? flag : undefined);
      expect(call).toEqual(original);
    }
  });
});
