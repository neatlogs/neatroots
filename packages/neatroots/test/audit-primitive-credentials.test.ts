import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuditArchive } from "../src/audit/archive.js";
import { redactRecord } from "../src/audit/redact-record.js";
import { compileRules, type RedactionHit } from "../src/relay/redact.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { await t?.close(); });

it("masks primitive credentials while preserving ordinary primitive values and the input", () => {
  const input = { password: 123456789, client_secret: false, api_secret: 42n, enabled: false, count: 23, large: 42n,
    nested: [{ passwd: true, pwd: [123, false], null_value: null }], text: "ordinary" };
  const before = structuredClone(input);
  const hits: RedactionHit[] = [];
  expect(redactRecord(input, compileRules([]), hits)).toEqual({ password: "[redacted:password]", client_secret: "[redacted:password]",
    api_secret: "[redacted:password]", enabled: false, count: 23, large: 42n,
    nested: [{ passwd: "[redacted:password]", pwd: ["[redacted:password]", "[redacted:password]"], null_value: null }], text: "ordinary" });
  expect(hits).toHaveLength(6);
  expect(JSON.stringify(hits)).not.toContain("123456789");
  expect(input).toEqual(before);
});

it("masks numeric/boolean sidecars and previews without altering original archive bytes", async () => {
  t = await makeRoots({ noEngine: true });
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "agent", kind: "workflow" })])]);
  t.roots.store.insertFinding({ trace_id: traceId, check_id: "primitive", check_kind: "rule", title: "primitive",
    probability: null, status: "raised", evidence_span_ids: [], model: null, triage_score: null, explanation_id: null,
    detail: { password: 246813579, enabled: true, count: 17 } });
  t.roots.store.insertDecision({ trace_id: traceId, check_id: "primitive", span_id: null, probability: 0.5,
    answer: { client_secret: false, retries: 3 }, backend: "local", latency_ms: 0 });
  const archive = new AuditArchive(t.roots);
  const original = archive.export(traceId);
  const originalFile = path.join(t.roots.home, "audit", path.dirname(original.path!), "record.json");
  const originalBytes = fs.readFileSync(originalFile);
  const output = path.join(t.roots.home, "share");
  const preview = archive.export(traceId, { redacted: true, output, preview: true });
  expect(JSON.stringify(preview)).not.toContain("246813579");
  expect(preview.redactions!.filter((h) => h.kind === "password")).toHaveLength(2);
  const shared = archive.export(traceId, { redacted: true, output, preview_token: preview.preview_token });
  const record = JSON.parse(fs.readFileSync(path.join(output, path.dirname(shared.path!), "record.json"), "utf8"));
  expect(record.record.findings[0].detail).toEqual({ password: "[redacted:password]", enabled: true, count: 17 });
  expect(record.record.decisions[0].answer).toEqual({ client_secret: "[redacted:password]", retries: 3 });
  expect(fs.readFileSync(originalFile)).toEqual(originalBytes);
  expect(JSON.parse(originalBytes.toString()).findings[0].detail.password).toBe(246813579);
});
