import { expect, it, vi } from "vitest";
import { runDetail } from "../src/server/api.js";
import { batch, hex, makeRoots, s, span } from "./helpers.js";

it("projects only strict, last-value booleans without hydrating full spans or blobs", async () => {
  const tb = await makeRoots({ noEngine: true });
  try {
    const traceId = hex(16);
    const key = "neatlogs.stream.cancelled";
    const controls = [
      [s(key, true)], [s(key, false)], [], [s(key, "true")], [s(key, 1)],
      [s(key, true), s(key, false)], [s(key, false), s(key, true)],
      [s(key, true), s(key, "true")],
    ];
    const spans = controls.map((attrs, i) => span({ traceId, name: `call-${i}`, kind: "llm", attrs: [
      ...attrs, s("neatlogs.llm.output_messages.0.content", "x".repeat(200000)),
    ] }));
    tb.roots.store.ingest([batch(spans)]);
    const before = tb.roots.store.getRun(traceId);
    const full = vi.spyOn(tb.roots.store, "getOtlpSpan").mockImplementation(() => { throw new Error("full-span hydration is forbidden"); });
    expect(tb.roots.store.spansWithBooleanAttribute(traceId, key)).toEqual(new Set([spans[0].spanId, spans[6].spanId]));
    expect(full).not.toHaveBeenCalled();
    full.mockRestore();
    // importSource already reads the root once; cancellation must add no reads.
    const detailReads = vi.spyOn(tb.roots.store, "getOtlpSpan");
    const detail = runDetail(tb.roots, traceId)!;
    expect(detail.spans.map((s) => s.stream_cancelled)).toEqual([true, false, false, false, false, false, true, false]);
    expect(detailReads).toHaveBeenCalledTimes(1);
    expect(detailReads).toHaveBeenCalledWith(traceId, before!.root_span_id);
    expect(tb.roots.store.getRun(traceId)).toEqual(before);
    detailReads.mockRestore();
    // Presentation reads preserve the original duplicate attributes and large payload.
    expect(tb.roots.store.getOtlpSpan(traceId, spans[5].spanId)?.span.attributes).toEqual(spans[5].attributes);
  } finally {
    await tb.close();
  }
});
