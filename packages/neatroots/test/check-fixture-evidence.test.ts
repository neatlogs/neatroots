import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { testCheckFixtures, formatFixtureReport } from "../src/checks/fixtures.js";
import * as regex from "../src/util/regex.js";
import { checkFiles } from "../src/checks/offline.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-evidence-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
let serial = 0;
const tid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sid = "0123456789abcdef";
function trace(output: unknown, traceId = tid, spanId = sid) {
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{
    traceId, spanId, name: "agent", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000",
    attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "workflow" } },
      ...(output === undefined ? [] : [{ key: "neatlogs.workflow.output", value: { stringValue: typeof output === "string" ? output : JSON.stringify(output) } }])],
    status: { code: 1 },
  }] }] }] };
}
function tools(names: string[], statuses = names.map(() => 1)) {
  const value = trace(undefined);
  value.resourceSpans[0].scopeSpans[0].spans = names.map((name, i) => ({
    ...trace(undefined, tid, String(i + 1).padStart(16, "0")).resourceSpans[0].scopeSpans[0].spans[0],
    name, startTimeUnixNano: String(1700000000000000000n + BigInt(i) * 100000000n),
    endTimeUnixNano: String(1700000000000000000n + BigInt(i) * 100000000n + 50000000n),
    attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "tool" } }], status: { code: statuses[i] },
  }));
  return value;
}
const check = "id: marker\nkind: rule\nrule: {type: match, field: output, pattern: marker}\n";
function suite(values: unknown[], expected: string[][], yaml = check) {
  const root = path.join(dir, String(++serial));
  fs.mkdirSync(path.join(root, "checks"), { recursive: true });
  fs.writeFileSync(path.join(root, "checks", "rule.yaml"), yaml);
  values.forEach((v, i) => fs.writeFileSync(path.join(root, `${i}.json`), JSON.stringify(v)));
  const manifest = path.join(root, "suite.json");
  const data = { version: 1, checks: "checks", rules: ["marker"], fixtures: values.map((_, i) => ({ id: `case-${i}`, trace: `${i}.json`, expected: expected[i] })) };
  fs.writeFileSync(manifest, JSON.stringify(data));
  return { root, manifest, data };
}

describe("strict fixture evidence", () => {
  it.each([false, true])("isolates equal-length reused IDs in both orders (%s)", (reverse) => {
    const values = [trace("marker"), trace("cleann")];
    const expected = [["marker"], []];
    if (reverse) { values.reverse(); expected.reverse(); }
    const s = suite(values, expected);
    for (let i = 0; i < 2; i++) expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 0 });
  });
  it("rejects a falsely expected positive after a matching equal-length case", () => {
    const s = suite([trace("marker"), trace("cleann")], [["marker"], ["marker"]]);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 1, fixtures: [{ passed: true }, { missing: ["marker"] }] });
  });
  it("reports evidence only, without raw output, title or params", () => {
    const secret = "PRIVATE_SENTINEL marker";
    const s = suite([trace(secret)], [["marker"]], check.replace("kind:", `title: ${secret}\nkind:`));
    const report = testCheckFixtures(s.manifest);
    expect(report).toMatchObject({ exit_code: 0, fixtures: [{ findings: [{ check_id: "marker", evidence_span_ids: [sid] }], rule_evaluations: [{ check_id: "marker", status: "evaluated", reason: "complete" }] }] });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatFixtureReport(report)).not.toContain(secret);
    expect(formatFixtureReport(report)).toContain(sid);
  });
  it("reports scope skips and makes them dominate an earlier mismatch", () => {
    const s = suite([trace("cleann")], [["marker"]], check + "applies_to: {project: absent}\n");
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 2, status: "error", fixtures: [{ rule_evaluations: [{ reason: "scope_mismatch", status: "unevaluated" }] }] });
  });
  it("distinguishes missing fields, no selector targets and completed negatives", () => {
    const missing = suite([trace(undefined)], [[]]);
    expect(testCheckFixtures(missing.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ rule_evaluations: [{ reason: "missing_match_field" }] }] });
    const absent = suite([trace("cleann")], [[]], check.replace("field: output", "span: {type: tool}, field: output"));
    expect(testCheckFixtures(absent.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ rule_evaluations: [{ reason: "no_match_targets" }] }] });
    const negative = suite([trace("cleann")], [[]]);
    expect(testCheckFixtures(negative.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ rule_evaluations: [{ status: "evaluated" }] }] });
  });
  it("does not quarantine later cases after an injected timeout", () => {
    const s = suite([trace("marker"), trace("marker")], [[], ["marker"]]);
    vi.spyOn(regex, "testWithin").mockReturnValueOnce(undefined);
    const report = testCheckFixtures(s.manifest);
    expect(report).toMatchObject({ exit_code: 2, fixtures: [{ passed: false, rule_evaluations: [{ status: "error", reason: "regex_timeout" }] }, { passed: true }] });
    expect(formatFixtureReport(report)).toContain("regex_timeout");
  });
  it("reports clipped match evidence even if the prefix matched", () => {
    const s = suite([trace("marker" + "x".repeat(200_001))], [["marker"]]);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ actual: ["marker"], rule_evaluations: [{ reason: "clipped_match_evidence" }] }] });
  });
  it("preserves earlier valid cases after a later invalid trace", () => {
    const s = suite([trace("marker"), {}], [["marker"], []]);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ passed: true }] });
  });
  it("preserves completed cases when a later file is missing", () => {
    const s = suite([trace("marker"), trace("cleann")], [["marker"], []]);
    fs.unlinkSync(path.join(s.root, "1.json"));
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ passed: true }] });
  });
  it("selects a trace before evaluating unrelated traces", () => {
    const selected = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const s = suite([[trace("poison"), trace("marker", selected)]], [["marker"]]);
    s.data.fixtures[0] = { ...s.data.fixtures[0], ...{ trace_id: selected } };
    fs.writeFileSync(s.manifest, JSON.stringify(s.data));
    const real = regex.testWithin;
    const spy = vi.spyOn(regex, "testWithin").mockImplementation((re, text, ms) => {
      if (text === "poison") throw new Error("unselected trace evaluated");
      return real(re, text, ms);
    });
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 0 });
    expect(spy.mock.calls.some(([, text]) => text === "poison")).toBe(false);
  });
  it("counts zero candidates as a completed comparison and permits empty run-level evidence", () => {
    const noTargets = suite([trace("clean")], [[]], "id: marker\nkind: rule\nrule: {type: count, span: {type: tool}, at_least: 1}\n");
    expect(testCheckFixtures(noTargets.manifest)).toMatchObject({ exit_code: 0 });
    const threshold = suite([trace("clean")], [["marker"]], "id: marker\nkind: rule\nrule: {type: threshold, metric: span_count, at_least: 1}\n");
    expect(testCheckFixtures(threshold.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ findings: [{ evidence_span_ids: [] }] }] });
  });
  it("sorts multiple evidence IDs without exposing evaluation exceptions", () => {
    const value = trace("marker", tid, "ffffffffffffffff");
    value.resourceSpans[0].scopeSpans[0].spans.push(trace("marker").resourceSpans[0].scopeSpans[0].spans[0]);
    const s = suite([value], [["marker"]]);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ fixtures: [{ findings: [{ evidence_span_ids: [sid, "ffffffffffffffff"] }] }] });
    vi.spyOn(regex, "testWithin").mockImplementation(() => { throw new Error("PRIVATE_EXCEPTION_SENTINEL"); });
    const report = testCheckFixtures(s.manifest);
    expect(report).toMatchObject({ exit_code: 2, fixtures: [{ rule_evaluations: [{ reason: "evaluation_error" }] }] });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_EXCEPTION_SENTINEL");
  });
  it("lets incomplete evaluation dominate an earlier completed mismatch", () => {
    const s = suite([trace("cleann"), trace("marker")], [["marker"], []]);
    const real = regex.testWithin;
    vi.spyOn(regex, "testWithin").mockImplementation((re, text, ms) => text === "marker" ? undefined : real(re, text, ms));
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 2, fixtures: [{ missing: ["marker"] }, { rule_evaluations: [{ reason: "regex_timeout" }] }] });
  });
  it("does not quote malformed trace content in a suite error", () => {
    const s = suite([trace("marker")], [["marker"]]);
    fs.writeFileSync(path.join(s.root, "0.json"), "PRIVATE_MALFORMED_SENTINEL");
    const report = testCheckFixtures(s.manifest);
    expect(report).toMatchObject({ exit_code: 2 });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_MALFORMED_SENTINEL");
    expect(formatFixtureReport(report)).not.toContain("PRIVATE_MALFORMED_SENTINEL");
  });
  it("reports only firing prerequisite findings, including false-positive expectations", () => {
    const yaml = "id: marker\nkind: rule\nrule: {type: requires_before, span: {tool: purchase}, requires: {tool: authorize}}\n";
    const satisfied = suite([tools(["authorize", "purchase"])], [[]], yaml);
    expect(testCheckFixtures(satisfied.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ actual: [] }] });
    const falsePositive = suite([tools(["authorize", "purchase"])], [["marker"]], yaml);
    expect(testCheckFixtures(falsePositive.manifest)).toMatchObject({ exit_code: 1, fixtures: [{ missing: ["marker"] }] });
    const missing = suite([tools(["purchase"])], [["marker"]], yaml);
    expect(testCheckFixtures(missing.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ actual: ["marker"] }] });
    const ordinary = checkFiles([path.join(satisfied.root, "0.json")], { dirs: [path.join(satisfied.root, "checks")], only: ["marker"] });
    expect(ordinary.runs[0].findings.map((f) => f.check_id)).toEqual(["marker"]);
  });
  it("treats a resolved error streak as a completed negative", () => {
    const yaml = "id: marker\nkind: rule\nrule: {type: errors, span: {type: tool}, consecutive: 2}\n";
    const s = suite([tools(["a", "b", "c"], [2, 2, 1])], [[]], yaml);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ actual: [], rule_evaluations: [{ status: "evaluated" }] }] });
    s.data.fixtures[0].expected = ["marker"];
    fs.writeFileSync(s.manifest, JSON.stringify(s.data));
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 1 });
  });
  it("treats a broken cycle as a completed negative", () => {
    const yaml = "id: marker\nkind: rule\nrule: {type: cycle, span: {type: tool}, max_period: 2, min_cycles: 3}\n";
    const s = suite([tools(["a", "b", "a", "b", "a", "b", "c"])], [[]], yaml);
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ actual: [] }] });
    s.data.fixtures[0].expected = ["marker"];
    fs.writeFileSync(s.manifest, JSON.stringify(s.data));
    expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 1 });
  });
  it.each(["json", "yaml", "check"])("does not copy malformed %s source into errors", (kind) => {
    const s = suite([trace("marker")], [["marker"]]);
    let manifest = s.manifest;
    if (kind === "check") fs.writeFileSync(path.join(s.root, "checks", "rule.yaml"), "id: marker\nPRIVATE_SOURCE_SENTINEL: [");
    else if (kind === "yaml") { manifest = path.join(s.root, "bad.yaml"); fs.writeFileSync(manifest, "PRIVATE_SOURCE_SENTINEL: ["); }
    else fs.writeFileSync(manifest, "PRIVATE_SOURCE_SENTINEL");
    const report = testCheckFixtures(manifest);
    expect(report).toMatchObject({ exit_code: 2 });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SOURCE_SENTINEL");
    expect(formatFixtureReport(report)).not.toContain("PRIVATE_SOURCE_SENTINEL");
  });
  it("keeps ordinary checks free of suite diagnostics and strict skip policy", () => {
    const s = suite([trace("clean")], [[]], check + "applies_to: {project: absent}\n");
    const ordinary = checkFiles([path.join(s.root, "0.json")], { dirs: [path.join(s.root, "checks")], only: ["marker"] });
    expect(ordinary.runs[0].findings).toEqual([]);
    expect(ordinary.runs[0]).not.toHaveProperty("rule_evaluations");
  });
});
