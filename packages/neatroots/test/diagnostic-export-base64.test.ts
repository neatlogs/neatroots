import { afterEach, expect, it } from "vitest";
import { DiagnosticOtlpScalars } from "../src/server/diagnostic-export-otlp.js";
import { DiagnosticRedactionBudget } from "../src/server/diagnostic-export-budget.js";
import { compileRules } from "../src/relay/redact.js";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { makeRoots, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
// UTF-8 (hi and a multibyte symbol) plus arbitrary non-UTF8 binary;
// distinguish both alphabets and both padding forms where the spelling differs.
const spellings = ["aGk", "aGk=", "8J+Suw==", "8J+Suw", "8J-Suw==", "8J-Suw", "+w==", "+w", "-w==", "-w", "//8=", "//8", "__8=", "__8"];

it("exports imported padded/unpadded standard/URL-safe bytes without changing payloads or storage", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true }); cleanup.push(tb.close);
  const traceId = "1234567890abcdef1234567890abcdef";
  const input = span({ traceId, name: "workflow", kind: "workflow" });
  input.attributes = spellings.map((bytesValue, i) => ({ key: `bytes-${i}`, value: { bytesValue } }));
  const batches = parseTraceFile(JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "test" }, spans: [input] }] }] }), "alternate-bytes.json");
  expect(batches[0].spans[0].attributes.map((a) => a.value)).toEqual(spellings.map((bytesValue) => ({ bytesValue })));
  tb.roots.ingest(batches);
  const before = structuredClone(tb.roots.store.batchesForTraces([traceId]));
  const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
  expect(response.status).toBe(200);
  const { bundle } = await response.json();
  const imported = parseTraceFile(JSON.stringify(bundle.trace), "exported-bytes.json");
  const values = imported[0].spans[0].attributes.map((a) => (a.value as { bytesValue: string }).bytesValue);
  expect(values).toEqual(spellings.map((value) => Buffer.from(value, "base64").toString("base64")));
  values.forEach((value, i) => expect(Buffer.from(value, "base64")).toEqual(Buffer.from(spellings[i], "base64")));
  const replay = await makeRoots({ noEngine: true }); cleanup.push(replay.close);
  replay.roots.ingest(imported);
  expect(replay.roots.store.batchesForTraces([traceId])[0].spans[0].attributes).toEqual(imported[0].spans[0].attributes);
  expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before);
});

it("checks alternate original, canonical encoded and decoded bytes against bounded redaction", () => {
  const path = "bundle.trace.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.bytesValue";
  const redact = (value: string, pattern: string) => new DiagnosticOtlpScalars({}, compileRules([pattern]), new DiagnosticRedactionBudget()).redact(path, value)!;
  expect(redact("aGk", "^aGk$")).toBe("");
  expect(redact("aGk", "^aGk=$")).toBe("");
  const text = redact("aGk", "hi");
  expect(Buffer.from(text, "base64").toString()).toContain("[redacted:custom]");
  expect(Buffer.from(text, "base64").toString("base64")).toBe(text);
  expect(redact("-w", "^-w$")).toBe("");
  expect(redact("-w", "^\\+w==$")).toBe("");
  expect(redact("-w", "absent")).toBe("+w==");
  for (const value of ["a", "aGk===", "aGk==", "aGl=", "a=Gk", "aG k", "aGk!", "aGk-?"]) expect(redact(value, "absent")).toBe("");
});
