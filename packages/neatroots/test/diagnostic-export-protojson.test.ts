import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticOtlpScalars } from "../src/server/diagnostic-export-otlp.js";
import { DiagnosticRedactionBudget } from "../src/server/diagnostic-export-budget.js";
import { fixedString, structuralKey } from "../src/server/diagnostic-export-schema.js";
import { compileRules } from "../src/relay/redact.js";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { batch, hex, makeRoots, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
const path = "bundle.trace.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.intValue";
const scalar = (patterns: string[] = []) => new DiagnosticOtlpScalars({}, compileRules(patterns), new DiagnosticRedactionBudget());

it("preserves exact accepted exponent integers through real import/export/reimport without changing storage", async () => {
  const values = ["1e3", "1E+3", "1000e-3", "1.5e1", "0.001e3", "9.007199254740993e15", "9.223372036854775807e18", "-9.223372036854775808e18", "-0e999999999999999999999"];
  const expected = ["1000", "1000", "1", "15", "1", "9007199254740993", "9223372036854775807", "-9223372036854775808", "0"];
  const input = span({ traceId: hex(16), name: "workflow", kind: "workflow" });
  input.attributes = values.map((intValue, i) => ({ key: `integer-${i}`, value: { intValue } }));
  const imported = parseTraceFile(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [input] }] }] }), "exponent.json");
  expect(imported[0].spans[0].attributes.map((a) => a.value)).toEqual(values.map((intValue) => ({ intValue })));
  const tb = await makeRoots({ serve: true, noEngine: true }); cleanup.push(tb.close); tb.roots.ingest(imported);
  const before = structuredClone(tb.roots.store.batchesForTraces([input.traceId]));
  const response = await fetch(`${tb.url}/api/runs/${input.traceId}/diagnostic-export`); expect(response.status).toBe(200);
  const { bundle } = await response.json();
  const replay = parseTraceFile(JSON.stringify(bundle.trace), "export.json");
  expect(replay[0].spans[0].attributes.map((a) => a.value)).toEqual(expected.map((intValue) => ({ intValue })));
  const target = await makeRoots({ noEngine: true }); cleanup.push(target.close); target.roots.ingest(replay);
  expect(target.roots.store.batchesForTraces([input.traceId])[0].spans[0].attributes).toEqual(replay[0].spans[0].attributes);
  expect(tb.roots.store.batchesForTraces([input.traceId])).toEqual(before);
});

it("preserves only the application export timestamp while redacting identical user data and keys", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["\\d+", "exported_at"]; } }); cleanup.push(tb.close);
  const traceId = hex(16), timestamp = "2026-10-17T12:34:56.789Z";
  tb.roots.ingest([batch([span({ traceId, name: "workflow", kind: "workflow", attrs: [{ key: "exported_at", value: { stringValue: timestamp } }] })])]);
  const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["saved"], params: { saved: { exported_at: timestamp } }, tools: [] }); tb.roots.store.setRunPlan(traceId, plan.id);
  const before = structuredClone(tb.roots.store.batchesForTraces([traceId]));
  const start = Date.now(); const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`); expect(response.status).toBe(200);
  const { bundle } = await response.json(); const exported = Date.parse(bundle.exported_at);
  expect(Number.isFinite(exported)).toBe(true); expect(exported).toBeGreaterThanOrEqual(start); expect(exported).toBeLessThanOrEqual(Date.now());
  const params = bundle.checks.historical.params[bundle.checks.historical.recorded_check_ids[0]];
  expect(Object.keys(params)).toEqual(["[redacted:custom]"]); expect(Object.values(params)[0]).toContain("[redacted:custom]"); expect(Object.values(params)[0]).not.toBe(timestamp);
  const attrs = bundle.trace.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  expect(attrs).toContainEqual({ key: "[redacted:custom]", value: { stringValue: expect.stringContaining("[redacted:custom]") } });
  expect(fixedString("bundle.exported_at", timestamp)).toBe(true);
  expect(fixedString("bundle.checks.historical.params.*.exported_at", timestamp)).toBe(false);
  expect(structuralKey("bundle", "exported_at")).toBe(true); expect(structuralKey("bundle.run", "exported_at")).toBe(false); expect(structuralKey("bundle.checks.historical.params.*", "exported_at")).toBe(false);
  expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before); expect(tb.roots.store.getPlan(plan.id)?.params).toEqual({ saved: { exported_at: timestamp } });
});

it("checks original and canonical integer spellings without floating-point rounding", () => {
  expect(scalar().redact(path, "1e3")).toBe("1000");
  expect(scalar(["^1e3$"]).redact(path, "1e3")).toBe("0");
  expect(scalar(["^1000$"]).redact(path, "1e3")).toBe("0");
  expect(scalar().redact(path, "9.007199254740993e15")).toBe("9007199254740993");
  for (const value of ["1e-3", "1.1", "1e19", "-9.223372036854775809e18", "9.223372036854775808e18", "1e", "1e+", "NaN", "1 e3"]) expect(scalar().redact(path, value)).toBe("0");
  expect(scalar().redact(path.replace(/attributes.*$/, "startTimeUnixNano"), "1.8446744073709551615e19")).toBe("18446744073709551615");
});

it("bounds exponent expansion before repeat or BigInt, including huge exponent spellings", () => {
  const huge = "9".repeat(4096), zeros = "0".repeat(4096);
  const repeat = vi.spyOn(String.prototype, "repeat"); const bigint = vi.spyOn(globalThis, "BigInt");
  for (const value of [`1e${huge}`, `1e-${huge}`, `1e${zeros}999999999`, `1e-${zeros}999999999`]) expect(scalar().redact(path, value)).toBe("0");
  expect(scalar().redact(path, `1e${zeros}3`)).toBe("1000");
  expect(scalar().redact(path, `0e${huge}`)).toBe("0");
  expect(bigint).not.toHaveBeenCalled(); for (const [count] of repeat.mock.calls) expect(count).toBeLessThanOrEqual(20);
});
