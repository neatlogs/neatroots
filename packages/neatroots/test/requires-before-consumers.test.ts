import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { loadTrace } from "../src/engine/trace.js";
import { httpTraceToBatches, type HttpTraceNode } from "../src/ingest/http-trace.js";
import { makeRoots } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const yaml = `id: refund-needs-lookup
kind: rule
rule:
  type: requires_before
  span: { tool: issue_refund }
  requires: { tool: lookup_order }
`;
const check = parseChecks(yaml).checks[0] as RuleCheck;
type Call = { tool: string; fail?: boolean };
const cases: { name: string; calls: Call[]; hit: boolean }[] = [
  { name: "satisfied", calls: [{ tool: "lookup_order" }, { tool: "issue_refund" }], hit: false },
  { name: "no guarded call", calls: [{ tool: "lookup_order" }], hit: false },
  { name: "missing prerequisite", calls: [{ tool: "issue_refund" }], hit: true },
  { name: "too late prerequisite", calls: [{ tool: "issue_refund" }, { tool: "lookup_order" }], hit: true },
  { name: "failed prerequisite", calls: [{ tool: "lookup_order", fail: true }, { tool: "issue_refund" }], hit: true },
  { name: "partially covered", calls: [{ tool: "issue_refund" }, { tool: "lookup_order" }, { tool: "issue_refund" }], hit: true },
];
function trace(name: string, calls: Call[]): HttpTraceNode {
  return { name, project: "prerequisite-consumers", start: Date.now() - 5000, output: "done",
    children: calls.map(c => ({ name: c.tool, tool_name: c.tool, input: "{}", output: c.fail ? undefined : "ok", status: c.fail ? "error" : "ok", duration_ms: 10 })) };
}
function files(body = yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-prerequisite-consumers-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checks = path.join(dir, "checks"); fs.mkdirSync(checks);
  fs.writeFileSync(path.join(checks, "rule.yaml"), body);
  return { dir, checks };
}
function cli(file: string, checks: string, home: string, ids = check.id) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "check", file, "--checks", checks, "--only", ids, "--json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, NEATROOTS_HOME: home }, encoding: "utf8", timeout: 15_000,
  });
}

describe("whole-run prerequisite consumers", () => {
  it.each(cases)("CLI JSON/JSONL reports $name correctly", sample => {
    const { dir, checks } = files();
    for (const extension of ["json", "jsonl"]) {
      const file = path.join(dir, `trace.${extension}`);
      fs.writeFileSync(file, JSON.stringify(trace(sample.name, sample.calls)) + (extension === "jsonl" ? "\n" : ""));
      const result = cli(file, checks, path.join(dir, "home"));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(sample.hit ? 1 : 0);
      const output = JSON.parse(result.stdout);
      expect(output.errors).toEqual([]);
      expect(output.runs).toHaveLength(1);
      expect(output.runs[0].findings.map((f: { check_id: string }) => f.check_id)).toEqual(sample.hit ? [check.id] : []);
    }
  });

  it("direct and REST preview distinguish fully satisfied runs from every uncovered case", async () => {
    const tb = await makeRoots({ serve: true }); cleanup.push(tb.close);
    const expected: string[] = [];
    for (const sample of cases) {
      const converted = httpTraceToBatches(trace(sample.name, sample.calls));
      tb.roots.ingest(converted.batches);
      if (sample.hit) expected.push(converted.traceId);
    }
    const direct = await tb.roots.engine!.previewCheck(check, { project: "prerequisite-consumers" });
    expect(direct.checked).toBe(cases.length);
    expect(direct.hits.map(h => h.trace_id).sort()).toEqual(expected.sort());
    const response = await fetch(`${tb.url}/api/checks/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check, project: "prerequisite-consumers" }) });
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.checked).toBe(cases.length);
    expect(preview.hits.map((h: { trace_id: string }) => h.trace_id).sort()).toEqual(expected);
  });

  it("offline, CLI and preview retain genuine repeat/errors/cycle violations after recovery", async () => {
    const rules: RuleCheck[] = [
      { id: "historical-repeat", kind: "rule", rule: { type: "repeat", span: { type: "tool" }, same: ["tool"], at_least: 2 } },
      { id: "historical-errors", kind: "rule", rule: { type: "errors", span: { type: "tool" }, consecutive: 2 } },
      { id: "historical-cycle", kind: "rule", rule: { type: "cycle", span: { type: "tool" }, max_period: 2, min_cycles: 3 } },
    ];
    const { dir, checks } = files(JSON.stringify(rules));
    const calls: Call[] = ["a", "b", "a", "b", "a", "b"].map(tool => ({ tool }));
    calls.push({ tool: "failure", fail: true }, { tool: "failure", fail: true }, { tool: "finish" });
    const body = trace("recovered violations", calls);
    const file = path.join(dir, "recovered.jsonl"); fs.writeFileSync(file, JSON.stringify(body) + "\n");
    const ids = rules.map(r => r.id).sort();
    const offline = checkFiles([file], { dirs: [checks], only: ids });
    expect(offline.errors).toEqual([]);
    expect(offline.runs[0].findings.map(f => f.check_id).sort()).toEqual(ids);
    const result = cli(file, checks, path.join(dir, "home"), ids.join(","));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).runs[0].findings.map((f: { check_id: string }) => f.check_id).sort()).toEqual(ids);
    const tb = await makeRoots(); cleanup.push(tb.close);
    const converted = httpTraceToBatches(body); tb.roots.ingest(converted.batches);
    for (const rule of rules) {
      const hit = evaluateRule(rule, loadTrace(tb.roots.store, converted.traceId), true);
      expect(hit).toMatchObject({ firing: false });
      expect(hit?.satisfied).not.toBe(true);
      expect((await tb.roots.engine!.previewCheck(rule, { project: "prerequisite-consumers" })).hits.map(h => h.trace_id)).toEqual([converted.traceId]);
    }
  });
});
