import { afterEach, expect, it, vi } from "vitest";
import { compileRules, redactBatches, redactString } from "../src/relay/redact.js";
import { DiagnosticRedactionBudget, DiagnosticExportTooLarge } from "../src/server/diagnostic-export-budget.js";
import { batch, hex, makeRoots, s, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

it.each(["trace", "metadata"])("times a saved custom pattern in limited %s export without returning partial data", async (location) => {
  const pattern = "ROUND2-SLOW";
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = [pattern]; } });
  cleanup.push(tb.close);
  const traceId = hex(16);
  tb.roots.ingest([batch([span({ traceId, name: "workflow", kind: "workflow", attrs: location === "trace" ? [s("input", pattern)] : [] })])]);
  if (location === "metadata") {
    const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["bounded"], params: { bounded: { instruction: pattern } }, tools: [] });
    tb.roots.store.setRunPlan(traceId, plan.id);
  }
  const before = structuredClone(tb.roots.store.batchesForTraces([traceId]));
  const exec = RegExp.prototype.exec;
  let slowCalls = 0;
  vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value: string) {
    if (this.source === pattern && value.includes(pattern)) {
      slowCalls++;
      // A deterministic finite stand-in for expensive exec: no huge input or runaway regex.
      const until = performance.now() + 200;
      while (performance.now() < until) { /* main's existing 100ms VM limit must interrupt */ }
    }
    return exec.call(this, value);
  });
  const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Diagnostic export could not apply a configured redaction pattern. Review redaction settings and try again." });
  expect(slowCalls).toBe(1);
  expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before);
  if (location === "metadata") expect(tb.roots.store.getPlan(tb.roots.store.getRun(traceId)!.plan_id!)!.params).toEqual({ bounded: { instruction: pattern } });
});

it("refuses an invalid saved pattern without echoing its source or a partial bundle", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["[ROUND2-INVALID"]; } });
  cleanup.push(tb.close);
  const traceId = hex(16);
  tb.roots.ingest([batch([span({ traceId, name: "workflow", kind: "workflow" })])]);
  const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
  expect(response.status).toBe(400);
  const text = await response.text();
  expect(text).not.toContain("ROUND2-INVALID");
  expect(JSON.parse(text)).toEqual({ error: expect.stringContaining("configured redaction pattern") });
});

it("keeps main scope-name redaction inside the diagnostic match budget", () => {
  const input = batch([span({ traceId: hex(16), name: "workflow", kind: "workflow" })]);
  input.scope.name = "q".repeat(11_000);
  expect(() => redactBatches([input], compileRules(["q"]), new DiagnosticRedactionBudget())).toThrow(DiagnosticExportTooLarge);
});

it("keeps saved legacy nested patterns and ordinary timed replacements equivalent", () => {
  const rules = compileRules(["(ab+)+", "(?=z)"]);
  expect(rules.filter((r) => r.kind === "custom").every((r) => r.timed)).toBe(true);
  const text = "abbb z Bearer SyntheticCredential0123456789";
  const detailed: { kind: string; where: string; sample: string }[] = [];
  const expected = redactString(text, rules, "fixture", detailed);
  const budget = new DiagnosticRedactionBudget();
  expect(redactString(text, rules, "", [], budget)).toBe(expected);
  expect(Object.fromEntries(budget.counts)).toEqual(detailed.reduce<Record<string, number>>((out, hit) => { out[hit.kind] = (out[hit.kind] ?? 0) + 1; return out; }, {}));
});


it("inherits main's newer credential/scope rules with identical limited and cloud output", () => {
  const token = "nlsa_" + "Round2LocalFixture".repeat(2);
  const value = `{"password":"Round2OnlyValue"} ${token} -----BEGIN RSA PRIVATE KEY-----\nRound2SyntheticBody`;
  const input = batch([span({ traceId: hex(16), name: "workflow", kind: "workflow", attrs: [s("input", value)] })]);
  input.scope.name = `tracer ${token}`;
  const before = structuredClone(input);
  const rules = compileRules([]);
  const expected = redactBatches([input], rules);
  const budget = new DiagnosticRedactionBudget();
  const actual = redactBatches([input], rules, budget);
  expect(actual.batches).toEqual(expected.batches);
  expect(actual.hits).toEqual([]);
  expect(Object.fromEntries(budget.counts)).toEqual(expected.hits.reduce<Record<string, number>>((out, hit) => { out[hit.kind] = (out[hit.kind] ?? 0) + 1; return out; }, {}));
  for (const kind of ["api_key", "password", "private_key"]) expect(budget.counts.get(kind)).toBeGreaterThan(0);
  const serialized = JSON.stringify(actual.batches);
  for (const secret of [token, "Round2OnlyValue", "Round2SyntheticBody"]) expect(serialized).not.toContain(secret);
  expect(input).toEqual(before);
});
