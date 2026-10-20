import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDiagnosticSource, DIAGNOSTIC_SOURCE_LIMIT, DiagnosticExportTooLarge, DiagnosticRedactionBudget, DIAGNOSTIC_JSON_LIMIT, DIAGNOSTIC_REDACTION_WORK_LIMIT } from "../src/server/diagnostic-export-budget.js";
import * as redaction from "../src/relay/redact.js";
import { batch, hex, makeRoots, s, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

describe("diagnostic redaction work limits", () => {
  for (const location of ["trace", "metadata"] as const) {
    for (const pattern of ["(?=x)", "x"]) {
      it(`bounds ${pattern} matching in ${location} below the source limit`, async () => {
        const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = [pattern]; } });
        cleanup.push(tb.close);
        const traceId = hex(16);
        const value = "x".repeat(11_000);
        tb.roots.ingest([batch([span({ traceId, name: "workflow", kind: "workflow", attrs: location === "trace" ? [s("input", value)] : [] })])]);
        if (location === "metadata") {
          const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["bounded"], params: { bounded: { instruction: value } }, tools: [] });
          tb.roots.store.setRunPlan(traceId, plan.id);
        }
        expect(checkDiagnosticSource(tb.roots, traceId)).toBeLessThan(DIAGNOSTIC_SOURCE_LIMIT);
        const before = structuredClone(tb.roots.store.batchesForTraces([traceId]));
        let matches = 0;
        const exec = RegExp.prototype.exec;
        vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text: string) {
          const match = exec.call(this, text);
          if (this.source === pattern && match) matches++;
          return match;
        });
        const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ error: expect.stringContaining("Choose a smaller run") });
        expect(matches).toBeLessThanOrEqual(10_001);
        expect(matches).toBeGreaterThan(0);
        expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before);
        if (location === "metadata") expect(tb.roots.store.getPlan(tb.roots.store.getRun(traceId)!.plan_id!)!.params).toEqual({ bounded: { instruction: value } });
      });
    }
  }

  it("shares the match budget with the second pass over already-redacted trace strings", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["a*"]; } });
    cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "workflow", kind: "workflow", attrs: [s("input", "x".repeat(1000))] })])]);
    const redactBatches = redaction.redactBatches;
    let traceFinished = false;
    vi.spyOn(redaction, "redactBatches").mockImplementation((...args) => { const result = redactBatches(...args); traceFinished = true; return result; });
    let matches = 0;
    const exec = RegExp.prototype.exec;
    vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text: string) {
      const match = exec.call(this, text);
      if (this.source === "a*" && match) matches++;
      return match;
    });
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(traceFinished).toBe(true);
    expect(response.status).toBe(413);
    expect(matches).toBeLessThanOrEqual(10_001);
  });

  it("keeps ordinary built-in/custom replacements and repeated-pass counts compatible", () => {
    const rules = redaction.compileRules(["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END", "(?=z)"]);
    const input = "Bearer SyntheticCredential0123456789 CLIENT-BEGIN:local-secret:CLIENT-END z𝄞 -----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
    const hits: redaction.RedactionHit[] = [];
    const expected = redaction.redactString(redaction.redactString(input, rules, "fixture", hits), rules, "fixture", hits);
    const budget = new DiagnosticRedactionBudget();
    const limitedHits: redaction.RedactionHit[] = [];
    const actual = redaction.redactString(redaction.redactString(input, rules, "fixture", limitedHits, budget), rules, "fixture", limitedHits, budget);
    expect(actual).toBe(expected);
    expect(Object.fromEntries(budget.counts)).toEqual(hits.reduce<Record<string, number>>((counts, hit) => { counts[hit.kind] = (counts[hit.kind] ?? 0) + 1; return counts; }, {}));
    expect(limitedHits).toEqual([]); // bounded exports retain counts, never per-position objects
    const unicodeRules = [{ kind: "custom", re: /(?=.)/gu }];
    expect(redaction.redactString("𝄞z", unicodeRules, "", [], new DiagnosticRedactionBudget())).toBe(redaction.redactString("𝄞z", unicodeRules, "", []));
  });

  it("enforces output and node limits before retaining unbounded work", () => {
    expect(() => new DiagnosticRedactionBudget().output("", DIAGNOSTIC_JSON_LIMIT + 1)).toThrow(DiagnosticExportTooLarge);
    const budget = new DiagnosticRedactionBudget();
    const fragment = "x".repeat(1024);
    for (let n = 0; n < DIAGNOSTIC_REDACTION_WORK_LIMIT / fragment.length; n++) budget.output(fragment, fragment.length);
    expect(() => budget.output("x", 1)).toThrow(DiagnosticExportTooLarge);
    expect(() => new DiagnosticRedactionBudget().node(65)).toThrow(DiagnosticExportTooLarge);
    const nodes = new DiagnosticRedactionBudget();
    for (let n = 0; n < 50_000; n++) nodes.node(0);
    expect(() => nodes.node(0)).toThrow(DiagnosticExportTooLarge);
  });

  it("omits deeply nested generated answers before recursive tree copies grow", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "nested metadata", kind: "workflow" })])]);
    let answer: unknown = "leaf";
    for (let i = 0; i < 80; i++) answer = [answer];
    tb.roots.store.insertDecision({ trace_id: traceId, check_id: "nested", span_id: null, probability: 0.1, answer: { nested: answer }, backend: "mock", latency_ms: 1 });
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    expect((await response.json()).bundle.checks.decisions[0]).toMatchObject({ answer: null, answer_omitted: true });
    expect(tb.roots.store.decisionsForTrace(traceId)[0].answer).toEqual({ nested: answer });
  });

});
