import { describe, expect, it } from "vitest";
import { httpTraceToBatches } from "../src/ingest/http-trace.js";
import { buildView } from "../src/semantics/view.js";
import { hex, s, span } from "./helpers.js";

// EVALUATOR is one of the documented Neatlogs span kinds (a scoring / evaluation step).
describe("EVALUATOR span kind", () => {
  it("keeps an evaluator sent to /v1/trace instead of turning it into UNKNOWN", () => {
    const { batches } = httpTraceToBatches({
      name: "agent",
      children: [{ name: "faithfulness", kind: "EVALUATOR", score: 0.12 }],
    });
    const evaluator = batches[0].spans.find((sp) => sp.name === "faithfulness")!;
    expect(buildView(evaluator, []).kind).toBe("EVALUATOR");
  });

  it("reads EVALUATOR from neatlogs.span.kind and openinference.span.kind", () => {
    const traceId = hex(16);
    expect(buildView(span({ traceId, name: "judge", kind: "EVALUATOR" }), []).kind).toBe("EVALUATOR");
    const oi = span({ traceId, name: "judge", kind: "x", attrs: [s("openinference.span.kind", "EVALUATOR")] });
    oi.attributes = oi.attributes.filter((a) => a.key !== "neatlogs.span.kind");
    expect(buildView(oi, []).kind).toBe("EVALUATOR");
  });
});
