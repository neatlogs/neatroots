import { describe, expect, it, vi, afterEach } from "vitest";
import { evaluateRule } from "../src/checks/rules.js";
import { beginEvaluation, createEvaluationContext } from "../src/checks/evaluation-context.js";
import type { RuleCheck } from "../src/checks/types.js";
import type { SpanInfo, TraceSnapshot } from "../src/engine/trace.js";
import * as regex from "../src/util/regex.js";
const rule: RuleCheck = { id: "marker", kind: "rule", rule: { type: "match", field: "output", pattern: "^ab$" } };
const span = (output: SpanInfo["output"], id = "same"): SpanInfo => ({ id, ref: id, parentId: null, name: "root", kind: "WORKFLOW", startMs: 1, endMs: 2, durationMs: 1, status: "ok", seq: 1, output });
const trace = (...spans: SpanInfo[]): TraceSnapshot => ({ traceId: "same", run: undefined, spans });
afterEach(() => vi.restoreAllMocks());
describe("fixture evaluation context", () => {
  it("keys corrected same-ID text by content and MCP segment boundaries", () => {
    const c = createEvaluationContext();
    const hit = (output: SpanInfo["output"]) => { beginEvaluation(c, rule.id); return evaluateRule(rule, trace(span(output)), true, undefined, true, c); };
    expect(hit("ab")).not.toBeNull();
    expect(hit("cd")).toBeNull();
    expect(hit({ content: [{ type: "text", text: "ab" }, { type: "text", text: "c" }] })).not.toBeNull();
    expect(hit({ content: [{ type: "text", text: "a" }, { type: "text", text: "bc" }] })).toBeNull();
  });
  it("reports partial targets, timeouts and quarantine without changing the hit contract", () => {
    const c = createEvaluationContext();
    beginEvaluation(c, rule.id);
    expect(evaluateRule(rule, trace(span("ab"), span(undefined, "missing")), true, undefined, true, c)).not.toBeNull();
    expect(c.outcome).toMatchObject({ status: "unevaluated", reason: "missing_match_field" });
    beginEvaluation(c, rule.id);
    vi.spyOn(regex, "testWithin").mockReturnValueOnce(undefined);
    evaluateRule(rule, trace(span("new")), true, undefined, true, c);
    expect(c.outcome).toMatchObject({ status: "error", reason: "regex_timeout" });
    beginEvaluation(c, rule.id);
    evaluateRule(rule, trace(span("ab")), true, undefined, true, c);
    expect(c.outcome).toMatchObject({ status: "error", reason: "regex_quarantined" });
  });
  it("reports run-dependent prerequisites and missing growth tokens", () => {
    for (const [spec, expected] of [
      [{ type: "threshold", metric: "span_count", at_least: 1 }, "missing_run"],
      [{ type: "unrecovered_error" }, "missing_completed_run"],
      [{ type: "run_end", when: "no_output" }, "missing_completed_run"],
      [{ type: "growth", min_calls: 5, rising: 0.8, factor: 3, min_tokens: 4000 }, "missing_token_evidence"],
    ] as const) {
      const c = createEvaluationContext(); beginEvaluation(c, rule.id);
      evaluateRule({ ...rule, rule: spec }, trace(span("ab")), true, undefined, true, c);
      expect(c.outcome).toMatchObject({ status: "unevaluated", reason: expected });
    }
  });
});
