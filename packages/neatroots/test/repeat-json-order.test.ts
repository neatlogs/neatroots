import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { evaluateRule } from "../src/checks/rules.js";
import type { RuleCheck } from "../src/checks/types.js";
import type { SpanInfo, TraceSnapshot } from "../src/engine/trace.js";
import { buildSpan } from "../src/ingest/build.js";
import type { Plain } from "../src/otlp/types.js";
import { buildView } from "../src/semantics/view.js";

const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks
  .find((c) => c.id === "repeated-tool-call") as RuleCheck;
type Call = { input: Plain; output: Plain };

function snapshot(calls: Call[]): TraceSnapshot {
  const spans = calls.map<SpanInfo>((call, seq) => {
    const span = buildSpan({
      traceId: "test-trace", spanId: `call-${seq}`, parentSpanId: "root",
      name: "lookup_order", kind: "tool", start: 1700000000000 + seq * 10, durationMs: 1,
      input: call.input, output: call.output,
    });
    const view = buildView(span, []);
    return {
      id: span.spanId, ref: span.spanId.slice(0, 6), parentId: span.parentSpanId,
      name: span.name, kind: view.kind, toolName: view.toolName, input: view.input, output: view.output,
      startMs: seq * 10, endMs: seq * 10 + 1, durationMs: 1, status: "ok", seq,
    };
  });
  return { traceId: "test-trace", run: undefined, spans };
}

const inputs: Plain[] = [
  { order: 4512, customer: "c1", region: "in" },
  { customer: "c1", region: "in", order: 4512 },
  { region: "in", order: 4512, customer: "c1" },
];

describe("repeat compares JSON values independently of object key order", () => {
  it("flags identical arguments with three different key orders", () => {
    const trace = snapshot(inputs.map((input) => ({ input, output: { found: false } })));
    expect(evaluateRule(rule, trace, false)).toMatchObject({ firing: true, evidenceSpanIds: trace.spans.map((s) => s.id) });
  });

  it("flags identical results with three different key orders", () => {
    const trace = snapshot(inputs.map((output) => ({ input: { order: 4512 }, output })));
    expect(evaluateRule(rule, trace, false)?.firing).toBe(true);
  });

  it("normalizes nested objects, including objects inside arrays, without changing the evidence", () => {
    const trace = snapshot(inputs.map((input) => ({ input: { filters: [input] }, output: { rows: [] } })));
    const original = JSON.stringify(trace);
    expect(evaluateRule(rule, trace, false)?.firing).toBe(true);
    expect(JSON.stringify(trace)).toBe(original);
  });

  it.each(["input", "output"] as const)("keeps changes to %s values distinct", (field) => {
    const trace = snapshot([1, 2, 3].map((n) => ({ input: { order: 4512 }, output: { found: false }, [field]: { page: n } })));
    expect(evaluateRule(rule, trace, false)).toBeNull();
  });

  it("keeps array order significant", () => {
    const trace = snapshot([[1, 2, 3], [2, 3, 1], [3, 1, 2]].map((rows) => ({ input: {}, output: { rows } })));
    expect(evaluateRule(rule, trace, false)).toBeNull();
  });

  it("keeps literal text distinct", () => {
    const trace = snapshot(["a=1,b=2", "b=2,a=1", "a=1, b=2"].map((input) => ({ input, output: "same" })));
    expect(evaluateRule(rule, trace, false)).toBeNull();
  });

  it("resolves the finding when the next call changes course", () => {
    const trace = snapshot([...inputs.map((input) => ({ input, output: { found: false } })), { input: { order: 9999 }, output: { found: true } }]);
    expect(evaluateRule(rule, trace, false)).toMatchObject({ firing: false, evidenceSpanIds: trace.spans.slice(0, 3).map((s) => s.id) });
  });
});
