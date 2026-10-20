import { afterEach, expect, it } from "vitest";
import { RuleSpec } from "../src/checks/types.js";
import { fixedString, structuralKey } from "../src/server/diagnostic-export-schema.js";
import { batch, hex, makeRoots, s, span } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
it("protects actual schema constants/enums while redacting identical data strings and map keys", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["neatroots", "json", "error", "yes_no"]; } }); cleanup.push(tb.close);
  const traceId = hex(16);
  tb.roots.ingest([batch([span({ traceId, name: "error", kind: "workflow", attrs: [s("format", "neatroots"), s("status", "error"), s("type", "json")] })])]);
  tb.roots.store.db.prepare("UPDATE runs SET status='error' WHERE trace_id=?").run(traceId);
  const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["saved", tb.roots.checks.library()[0].check.id], params: { saved: { error: "error", format: "neatroots", type: "json", kind: "yes_no" } }, tools: [] }); tb.roots.store.setRunPlan(traceId, plan.id);
  tb.roots.checks.save({ id: "rule-errors", kind: "rule", rule: { type: "errors", consecutive: 3 } }, "db", "planner");
  const out = await (await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`)).json();
  expect(out.bundle.format).toBe("neatroots.diagnostic-export"); expect(out.bundle.trace.format).toBe("otlp-json"); expect(out.bundle.run.status).toBe("error");
  expect(out.bundle.checks.current_definitions.some((d: { definition?: { kind?: string } }) => d.definition?.kind === "yes_no")).toBe(true);
  expect(out.bundle.checks.current_definitions).toContainEqual(expect.objectContaining({ rule_summary: { type: "errors", consecutive: 3 } }));
  expect(out.bundle.checks.current_definitions.some((d: { definition?: { rule?: { when?: string } } }) => d.definition?.rule?.when === "error")).toBe(true);
  const alias = out.bundle.checks.historical.recorded_check_ids[0];
  expect(out.bundle.checks.historical.params[alias]).toEqual({ "[redacted:custom]": "[redacted:custom]", format: "[redacted:custom]", type: "[redacted:custom]", kind: "[redacted:custom]" });
  const sp = out.bundle.trace.resourceSpans[0].scopeSpans[0].spans[0]; expect(sp.name).toBe("[redacted:custom]");
  expect(sp.attributes).toEqual(expect.arrayContaining([s("format", "[redacted:custom]"), s("status", "[redacted:custom]"), s("type", "[redacted:custom]")]));
  expect(out.bundle.checks.current_definitions.some((d: { definition?: { rule?: { type?: string } } }) => d.definition?.rule?.type === "errors")).toBe(true);
  for (const d of out.bundle.checks.current_definitions) if (d.definition?.rule?.type === "errors") expect(d.definition.rule.type).toBe("errors");
  expect(out.bundle.redactions.matches).toContainEqual({ kind: "custom", count: expect.any(Number) });
});


it("keeps interrupted and omission metadata schema positions intact while sanitizing identical user data", async () => {
  const names = ["definition_omitted", "rule_summary", "params_provenance", "answer_omitted"];
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = [...names, "interrupted"]; } }); cleanup.push(tb.close);
  const traceId = hex(16);
  tb.roots.ingest([batch([span({ traceId, name: "interrupted", kind: "workflow", attrs: [s("neatlogs.trace.interrupted", true), ...names.map((name) => s(name, "interrupted"))] })])]);
  expect(tb.roots.store.getRun(traceId)!.status).toBe("interrupted");
  tb.roots.checks.save({ id: "metadata-rule", kind: "rule", rule: { type: "count", at_least: 99 } }, "db", "planner");
  const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["metadata-rule"], params: { "metadata-rule": Object.fromEntries([...names, "interrupted"].map((name) => [name, "interrupted"])) }, tools: [] }); tb.roots.store.setRunPlan(traceId, plan.id);
  tb.roots.store.insertDecision({ trace_id: traceId, check_id: "metadata-rule", span_id: null, probability: 0.5, answer: { choice: "interrupted" }, backend: "mock", latency_ms: 1 });
  const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`); expect(response.status).toBe(200);
  const out = await response.json();
  expect(out.bundle.run.status).toBe("interrupted");
  expect(out.bundle.checks.historical.params_provenance).toBe("user");
  const alias = out.bundle.checks.historical.recorded_check_ids[0];
  expect(out.bundle.checks.current_definitions.find((d: { check_id: string }) => d.check_id === alias)).toMatchObject({ definition_omitted: "unverified-provenance", rule_summary: { type: "count", at_least: 99 } });
  expect(out.bundle.checks.decisions[0]).toMatchObject({ answer: null, answer_omitted: true, check_id: alias });
  expect(out.bundle.checks.historical.params[alias]).toEqual(Object.fromEntries(names.concat("interrupted").map((_, i) => [i === 0 ? "[redacted:custom]" : `[redacted:custom] [${i + 1}]`, "[redacted:custom]"])));
  const sp = out.bundle.trace.resourceSpans[0].scopeSpans[0].spans[0]; expect(sp.name).toBe("[redacted:custom]");
  for (const name of names) expect(sp.attributes).not.toContainEqual(s(name, "interrupted"));
  expect(sp.attributes.filter((a: { key: string }) => a.key === "[redacted:custom]")).toHaveLength(names.length);
});

it("uses actual rule discriminator domains and protects new keys only at their schema positions", () => {
  for (const option of RuleSpec.options) {
    const type = option.shape.type.value;
    for (const prefix of ["definition.rule", "rule_summary"]) expect(fixedString(`bundle.checks.current_definitions[0].${prefix}.type`, type)).toBe(true);
  }
  expect(fixedString("bundle.checks.current_definitions[0].definition.rule.type", "token_growth")).toBe(false);
  expect(fixedString("bundle.checks.current_definitions[0].definition.rule.metric", "input")).toBe(false);
  expect(fixedString("bundle.checks.current_definitions[0].definition.rule.field", "total_tokens")).toBe(false);
  expect(fixedString("bundle.checks.current_definitions[0].definition.rule.same[0]", "model")).toBe(false);
  for (const [key, parent] of Object.entries({ definition_omitted: "bundle.checks.current_definitions[0]", rule_summary: "bundle.checks.current_definitions[0]", params_provenance: "bundle.checks.historical", answer_omitted: "bundle.checks.decisions[0]" })) {
    expect(structuralKey(parent, key)).toBe(true);
    expect(structuralKey("bundle.checks.historical.params.*", key)).toBe(false);
    expect(structuralKey("bundle.run", key)).toBe(false);
  }
});
