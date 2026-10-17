import { afterEach, expect, it } from "vitest";
import { structuralKey } from "../src/server/diagnostic-export-schema.js";
import { DiagnosticOtlpScalars, otlpScalar } from "../src/server/diagnostic-export-otlp.js";
import { DiagnosticRedactionBudget } from "../src/server/diagnostic-export-budget.js";
import { compileRules } from "../src/relay/redact.js";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { batch, makeRoots, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it.each(["\\d+", "."])("reimports typed OTLP and keeps correlated distinct identities with %s", async (pattern) => {
  const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = [pattern]; } });
  cleanup.push(tb.close);
  const traceId = "1234567890abcdef1234567890abcdef";
  const rootId = "1234567890abcdef";
  const childId = "fedcba0987654321";
  const externalTrace = "9876543210abcdef9876543210abcdef";
  const externalSpan = "9876543210abcdef";
  const root = span({ traceId, spanId: rootId, name: "workflow", kind: "workflow" });
  root.startTimeUnixNano = "1700000000000000000"; root.endTimeUnixNano = "1700000002000000000";
  const child = span({ traceId, spanId: childId, parent: rootId, name: "child", kind: "tool" });
  child.startTimeUnixNano = "1700000000000000001"; child.endTimeUnixNano = "1700000001000000002";
  child.events = [{ name: "event", timeUnixNano: "1700000000500000003", attributes: [{ key: "count", value: { intValue: "-9223372036854775808" } }] }];
  child.links = [{ traceId, spanId: rootId, attributes: [] }, { traceId: externalTrace, spanId: externalSpan, attributes: [] }];
  child.attributes = [
    { key: "count", value: { intValue: "9223372036854775807" } },
    { key: "bytes", value: { bytesValue: Buffer.from("scalar-secret-123").toString("base64") } },
    { key: "nested", value: { arrayValue: { values: [{ kvlistValue: { values: [{ key: "intValue", value: { intValue: "123" } }, { key: "spanId", value: { stringValue: childId } }] } }] } } },
  ];
  const input = batch([root, child]);
  input.resource.attributes.push({ key: "res", value: { intValue: "123" } });
  input.scope.attributes = [{ key: "scope", value: { arrayValue: { values: [{ intValue: "123" }] } } }];
  tb.roots.ingest([input]);
  const finding = tb.roots.store.insertFinding({ trace_id: traceId, check_id: "scalar-check", check_kind: "rule", title: "finding", probability: null, status: "raised", evidence_span_ids: [rootId, childId], detail: { span_id: childId, occurrences: [rootId, childId] }, model: null, triage_score: null, explanation_id: null });
  tb.roots.store.insertDecision({ trace_id: traceId, check_id: "scalar-check", span_id: childId, probability: 0.1, answer: {}, backend: "mock", latency_ms: 1 });
  const params = Object.fromEntries(["spanId", "traceId", "intValue", "startTimeUnixNano", "bytesValue"].map((key) => [key, "123"]));
  const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: ["scalar-check"], params: { "scalar-check": params }, tools: [] });
  tb.roots.store.setRunPlan(traceId, plan.id);
  const before = structuredClone(tb.roots.store.batchesForTraces([traceId]));
  const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
  expect(response.status).toBe(200);
  const { bundle } = await response.json();
  // Real file parser plus actual ingestion catches BigInt(timestamp) failures and ID collisions.
  const imported = parseTraceFile(JSON.stringify(bundle.trace), "diagnostic-trace.json");
  const replay = await makeRoots({ noEngine: true }); cleanup.push(replay.close);
  expect(() => replay.roots.ingest(imported)).not.toThrow();
  const spans = imported.flatMap((b) => b.spans);
  expect(spans).toHaveLength(2);
  const [exportedRoot, exportedChild] = spans;
  expect(exportedRoot.traceId).toMatch(/^[a-f0-9]{32}$/);
  expect(exportedRoot.spanId).toMatch(/^[a-f0-9]{16}$/);
  expect(exportedChild.spanId).toMatch(/^[a-f0-9]{16}$/);
  expect(exportedRoot.spanId).not.toBe(exportedChild.spanId);
  expect(exportedChild.traceId).toBe(exportedRoot.traceId);
  expect(exportedChild.parentSpanId).toBe(exportedRoot.spanId);
  expect(exportedChild.links[0]).toMatchObject({ traceId: exportedRoot.traceId, spanId: exportedRoot.spanId });
  expect(exportedChild.links[1].traceId).not.toBe(exportedRoot.traceId);
  expect(exportedChild.links[1].spanId).not.toBe(exportedChild.spanId);
  expect(bundle.run).toMatchObject({ trace_id: exportedRoot.traceId, root_span_id: exportedRoot.spanId });
  expect(bundle.findings[0].evidence_span_ids).toEqual([exportedRoot.spanId, exportedChild.spanId]);
  expect(bundle.findings[0].detail).toMatchObject({ span_id: exportedChild.spanId, occurrences: [exportedRoot.spanId, exportedChild.spanId] });
  expect(bundle.checks.decisions[0].span_id).toBe(exportedChild.spanId);
  expect(replay.roots.store.batchesForTraces([exportedRoot.traceId]).flatMap((b) => b.spans)).toHaveLength(2);
  expect(exportedChild.startTimeUnixNano).toBe("0"); expect(exportedChild.endTimeUnixNano).toBe("0");
  expect(exportedChild.events[0].timeUnixNano).toBe("0");
  expect(exportedChild.attributes[0].value).toEqual({ intValue: "0" });
  expect(exportedChild.events[0].attributes[0].value).toEqual({ intValue: "0" });
  const bytes = (exportedChild.attributes[1].value as { bytesValue: string }).bytesValue;
  expect(Buffer.from(bytes, "base64").toString("base64")).toBe(bytes);
  expect(Buffer.from(bytes, "base64").toString()).not.toContain("123");
  const nested = exportedChild.attributes[2].value as { arrayValue: { values: { kvlistValue: { values: { value: unknown }[] } }[] } };
  expect(nested.arrayValue.values[0].kvlistValue.values[0].value).toEqual({ intValue: "0" });
  expect(nested.arrayValue.values[0].kvlistValue.values[1].value).not.toEqual({ stringValue: exportedChild.spanId });
  const exportedParams = bundle.checks.historical.params[bundle.checks.historical.recorded_check_ids[0]];
  expect(Object.values(exportedParams)).toHaveLength(5);
  for (const value of Object.values(exportedParams)) expect(value).toContain("[redacted:custom]");
  expect(tb.roots.store.getPlan(plan.id)?.params).toEqual({ "scalar-check": params });
  expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before);
  expect(tb.roots.store.getFinding(finding.id)?.evidence_span_ids).toEqual([rootId, childId]);
});


it("selects exact scalar paths and keeps unrelated data-bearing names sanitizable", () => {
  const sp = "bundle.trace.resourceSpans[0].scopeSpans[0].spans[0]";
  expect(structuralKey("bundle.checks", "historical")).toBe(true);
  expect(structuralKey("bundle.checks.historical.params.*", "historical")).toBe(false);
  expect(structuralKey("bundle.findings[0].detail", "occurrences")).toBe(true);
  expect(structuralKey("bundle.checks.historical.params.*", "occurrences")).toBe(false);
  for (const field of ["traceId", "spanId", "startTimeUnixNano", "intValue", "bytesValue"]) {
    expect(otlpScalar(`bundle.checks.historical.params.*.${field}`)).toBeUndefined();
    expect(otlpScalar(`${sp}.attributes[0].value.kvlistValue.values[0].${field}`)).toBeUndefined();
  }
  expect(otlpScalar(`${sp}.startTimeUnixNano`)).toBe("nanos");
  expect(otlpScalar(`${sp}.events[0].timeUnixNano`)).toBe("nanos");
  expect(otlpScalar(`${sp}.links[0].traceId`)).toBe("trace");
  expect(otlpScalar(`${sp}.attributes[0].value.arrayValue.values[0].kvlistValue.values[0].value.intValue`)).toBe("int");
  const scalar = new DiagnosticOtlpScalars({}, compileRules([]), new DiagnosticRedactionBudget());
  const intPath = `${sp}.attributes[0].value.intValue`;
  expect(scalar.redact(intPath, "1e3")).toBe("1000");
  for (const n of ["-9223372036854775808", "9223372036854775807", "0"]) expect(scalar.redact(intPath, n)).toBe(n);
  for (const n of ["9223372036854775808", "-9223372036854775809", "123secret", "1e-3"]) expect(scalar.redact(intPath, n)).toBe("0");
  expect(scalar.redact(`${sp}.startTimeUnixNano`, "18446744073709551615")).toBe("18446744073709551615");
  for (const n of ["-1", "18446744073709551616", "not-a-number"]) expect(scalar.redact(`${sp}.startTimeUnixNano`, n)).toBe("0");
  expect(scalar.redact(`${sp}.parentSpanId`, "")).toBe("");
  expect(scalar.redact(`${sp}.attributes[0].value.bytesValue`, "/wAB")).toBe("/wAB");
  expect(scalar.redact(`${sp}.attributes[0].value.bytesValue`, "not base64!")).toBe("");
  expect(scalar.redact("bundle.checks.historical.params.*.intValue", "123")).toBeUndefined();
});

it("redacts encoded and decoded bytes without losing base64 validity", () => {
  const path = "bundle.trace.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.bytesValue";
  const redact = (pattern: string, value: string) => new DiagnosticOtlpScalars({}, compileRules([pattern]), new DiagnosticRedactionBudget()).redact(path, value)!;
  const encoded = Buffer.from("secret").toString("base64");
  expect(redact("c2VjcmV0", encoded)).toBe("");
  const decodedMatch = redact("secret", encoded);
  expect(Buffer.from(decodedMatch, "base64").toString("base64")).toBe(decodedMatch);
  expect(Buffer.from(decodedMatch, "base64").toString()).toContain("[redacted:custom]");
  expect(Buffer.from(decodedMatch, "base64").toString()).not.toContain("secret");
  expect(redact("absent", encoded)).toBe(encoded);
  expect(redact("absent", "/wAB")).toBe("/wAB");
  expect(redact("/wAB", "/wAB")).toBe("");
});
