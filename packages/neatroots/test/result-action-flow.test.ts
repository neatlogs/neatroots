import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnyCheck, type RuleCheck } from "../src/checks/types.js";
import { checkFiles } from "../src/checks/offline.js";
import { batch, hex, makeRoots, markerSpan, s, span, tmpHome, toolSpan, until } from "./helpers.js";

const contract = (): RuleCheck => AnyCheck.parse({ id: "permission-contract", kind: "rule", rule: {
  type: "result_action", result: { tool: "permission" }, path: ["allowed"], equals: false,
  forbids: { tool: "write" }, within_ms: 5000, scope: "same_parent", clock: "same",
} }) as RuleCheck;

function recorded(traceId: string, root: string, blocked: boolean) {
  const result = toolSpan(traceId, root, "permission", "{}", JSON.stringify({ allowed: !blocked, private_note: "never include this" }));
  const action = toolSpan(traceId, root, "write", "{}", '{"ok":true}');
  const parent = span({ traceId, spanId: root, name: "contract-run", kind: "workflow", attrs: [s("neatlogs.workflow.output", "done")] });
  parent.startTimeUnixNano = String(BigInt(result.startTimeUnixNano) - 1_000_000n);
  parent.endTimeUnixNano = String(BigInt(action.endTimeUnixNano) + 1_000_000n);
  return { result, action, parent };
}

describe("result/action recorded flow", () => {
  it("evaluates 120 labeled saved OTLP runs through the actual importer, SQLite and offline checks", () => {
    const home = tmpHome();
    try {
      const checks = path.join(home, "checks");
      fs.mkdirSync(checks);
      fs.writeFileSync(path.join(checks, "contract.json.yaml"), JSON.stringify(contract()));
      const files = Array.from({ length: 120 }, (_, i) => {
        const traceId = hex(16);
        const root = hex(8);
        const { result, action, parent } = recorded(traceId, root, i % 2 === 0);
        const file = path.join(home, `labeled-${i}.json`);
        fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: batch([]).resource, scopeSpans: [{ scope: batch([]).scope, spans: [result, action, parent] }] }] }));
        return file;
      });
      const result = checkFiles(files, { dirs: [checks], only: ["permission-contract"] });
      expect(result.errors).toEqual([]);
      expect(result.runs).toHaveLength(120);
      result.runs.forEach((run, i) => {
        expect(run.findings.length, `label ${i}`).toBe(i % 2 === 0 ? 1 : 0);
        expect(run.rule_evaluations).toEqual([{ check_id: "permission-contract", actions: 1, evaluated: 1, matched: i % 2 === 0 ? 1 : 0, skipped: {} }]);
      });
      expect(JSON.stringify(result)).not.toContain("never include this");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("never joins colliding span and parent ids from different trace containers", () => {
    const home = tmpHome();
    try {
      const checks = path.join(home, "checks");
      fs.mkdirSync(checks);
      fs.writeFileSync(path.join(checks, "contract.yaml"), JSON.stringify(contract()));
      const root = hex(8);
      const first = recorded(hex(16), root, true);
      const second = recorded(hex(16), root, false);
      second.result.spanId = first.result.spanId;
      second.action.spanId = first.action.spanId;
      const file = path.join(home, "two-traces.json");
      fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: batch([]).resource, scopeSpans: [{ scope: batch([]).scope, spans: [first.result, first.parent, second.action, second.parent] }] }] }));
      const result = checkFiles([file], { dirs: [checks], only: ["permission-contract"] });
      expect(result.runs).toHaveLength(2);
      expect(result.runs.flatMap((r) => r.findings)).toEqual([]);
      expect(result.runs.flatMap((r) => r.rule_evaluations ?? []).find((r) => r.actions === 1)?.skipped).toEqual({ no_preceding_result: 1 });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("uses the normal end-of-run path and does not persist offline coverage", async () => {
    const tb = await makeRoots();
    try {
      tb.roots.checks.save(contract(), "db", "mcp");
      const traceId = hex(16);
      const root = hex(8);
      const { result, action, parent } = recorded(traceId, root, true);
      tb.roots.ingest([batch([result, action])]);
      await tb.roots.engine!.waitIdle(traceId, 5000);
      expect(tb.roots.store.findingsForTrace(traceId).filter((f) => f.check_id === "permission-contract")).toEqual([]);
      tb.roots.ingest([batch([parent, markerSpan(traceId, root)])]);
      const finding = await until(() => tb.roots.store.findingsForTrace(traceId).find((f) => f.check_id === "permission-contract"));
      expect(finding.evidence_span_ids).toEqual([result.spanId, action.spanId]);
      expect(finding.detail.params).not.toHaveProperty("rule_version");
      expect(finding.detail.params).not.toHaveProperty("skipped");
      expect(finding.detail.params).not.toHaveProperty("notice");
      expect(tb.roots.store.notesForTrace(traceId).filter((n) => n.finding_id === finding.id)).toEqual([]);
    } finally { await tb.close(); }
  });
});

describe("offline contract CLI coverage", () => {
  it("reports no actions and fully evaluated clean actions as clean, but marks skipped actions", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const home = tmpHome();
    try {
      const checks = path.join(home, "checks"); fs.mkdirSync(checks);
      fs.writeFileSync(path.join(checks, "contract.yaml"), JSON.stringify(contract()));
      for (const mode of ["no-action", "clean-action", "skipped-action"]) {
        const traceId = hex(16), root = hex(8);
        const { result, action, parent } = recorded(traceId, root, false);
        const spans = mode === "no-action" ? [result, parent] : mode === "clean-action" ? [result, action, parent] : [action, parent];
        const file = path.join(home, `${mode}.json`);
        fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: batch([]).resource, scopeSpans: [{ spans }] }] }));
        const args = ["--import", "tsx", "src/cli.ts", "check", file, "--checks", checks, "--only", "permission-contract"];
        const out = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, NEATROOTS_HOME: path.join(home, "isolated") }, encoding: "utf8" });
        expect(out.status, out.stderr).toBe(0);
        if (mode === "skipped-action") {
          expect(out.stdout).toContain("? "); expect(out.stdout).toContain("coverage incomplete"); expect(out.stdout).toContain("0/1 actions evaluated");
        } else {
          expect(out.stdout).toContain("✓ "); expect(out.stdout).not.toContain("coverage incomplete"); expect(out.stdout).not.toContain("actions evaluated");
        }
        const json = checkFiles([file], { dirs: [checks], only: ["permission-contract"] });
        expect(json.runs[0].rule_evaluations?.[0].actions).toBe(mode === "no-action" ? 0 : 1);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
