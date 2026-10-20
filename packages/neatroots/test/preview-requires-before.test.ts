import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkFiles } from "../src/checks/offline.js";
import { evaluateRule } from "../src/checks/rules.js";
import type { RuleCheck } from "../src/checks/types.js";
import { loadTrace } from "../src/engine/trace.js";
import { batch, hex, makeRoots, markerSpan, span, toolSpan, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const check: RuleCheck = {
  id: "preview-refund-prerequisite", kind: "rule",
  rule: { type: "requires_before", span: { tool: "refund" }, requires: { tool: "lookup" } },
};

function addRun(tb: TestRoots, name: string, tools: string[], failedLookup = false): string {
  const traceId = hex(16), rootId = hex(8);
  tb.roots.ingest([batch([
    span({ traceId, spanId: rootId, name, kind: "workflow" }),
    ...tools.map((tool) => toolSpan(traceId, rootId, tool, "{}", "ok", failedLookup && tool === "lookup" ? "failed" : undefined)),
    markerSpan(traceId, rootId),
  ])]);
  return traceId;
}

describe("whole-run requires_before verdicts", () => {
  it("reports satisfied and unguarded runs as clear through preview, REST and MCP", async () => {
    const tb = await makeRoots({ serve: true });
    cleanup.push(tb.close);
    const good = addRun(tb, "satisfied", ["lookup", "refund"]);
    const unguarded = addRun(tb, "no-guarded-call", ["lookup"]);
    const bad = addRun(tb, "missing-prerequisite", ["refund"]);
    const late = addRun(tb, "too-late", ["refund", "lookup"]);
    const failed = addRun(tb, "failed-prerequisite", ["lookup", "refund"], true);
    const partial = addRun(tb, "partially-satisfied", ["refund", "lookup", "refund"]);
    const assertVerdicts = (result: any) => {
      expect(result).toMatchObject({ checked: 6, total: 6, skipped: {}, errors: {}, truncated: false });
      expect(result.results).toHaveLength(6);
      for (const trace_id of [good, unguarded]) {
        expect(result.results.find((r: any) => r.trace_id === trace_id)).toMatchObject({ status: "clear", reason: "no_hit" });
      }
      for (const trace_id of [bad, late, failed, partial]) {
        expect(result.results.find((r: any) => r.trace_id === trace_id)).toMatchObject({ status: "hit" });
      }
    };
    const direct = await tb.roots.engine!.previewCheck(check);
    assertVerdicts(direct);
    expect(direct.hits.map((hit) => hit.trace_id).sort()).toEqual([bad, late, failed, partial].sort());

    const response = await fetch(`${tb.url}/api/checks/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check }),
    });
    expect(response.status).toBe(200);
    const api = await response.json();
    assertVerdicts(api);
    expect(api.hits).toHaveLength(4);
    expect(api.hit_rate).toBeCloseTo(4 / 6);

    const client = new Client({ name: "requires-before-preview-test", version: "1.0.0" });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
    const tool = await client.callTool({ name: "preview_check", arguments: { check: JSON.stringify(check) } });
    const mcp = JSON.parse(tool.content[0].text);
    assertVerdicts(mcp);
    expect(mcp.hits).toBe(4);
    expect(mcp.hit_rate).toBeCloseTo(4 / 6);
  });

  it("does not suppress real repeat, errors or cycle violations after they stop firing", async () => {
    const tb = await makeRoots();
    cleanup.push(tb.close);
    const traceId = addRun(tb, "recovered", ["a", "b", "a", "b", "a", "b", "finish"]);
    const rules: RuleCheck[] = [
      { id: "repeat", kind: "rule", rule: { type: "repeat", span: { type: "tool" }, same: ["tool"], at_least: 2 } },
      { id: "cycle", kind: "rule", rule: { type: "cycle", span: { type: "tool" }, max_period: 2, min_cycles: 3 } },
    ];
    // Two failed lookups followed by success end the streak but do not erase the violation.
    const errorsTrace = addRun(tb, "recovered-errors", ["lookup", "lookup", "finish"], true);
    rules.push({ id: "errors", kind: "rule", rule: { type: "errors", span: { type: "tool" }, consecutive: 2 } });
    for (const rule of rules) {
      const id = rule.id === "errors" ? errorsTrace : traceId;
      expect(evaluateRule(rule, loadTrace(tb.roots.store, id), true)).toMatchObject({ firing: false });
      const result = await tb.roots.engine!.previewCheck(rule);
      expect(result.results.find((r) => r.trace_id === id)).toMatchObject({ status: "hit" });
      expect(result.hits.some((hit) => hit.trace_id === id)).toBe(true);
    }
  });

  it("uses the same satisfied contract for offline checks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-preview-prerequisite-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "rule.yaml"), JSON.stringify(check));
    const files = [["lookup", "refund"], ["refund"]].map((tools, index) => {
      const file = path.join(dir, `run-${index}.json`);
      fs.writeFileSync(file, JSON.stringify({ name: "refund-agent", output: "done", children: tools.map((tool) => ({ name: tool, tool_name: tool, duration_ms: 10, output: "ok" })) }));
      return file;
    });
    const result = checkFiles(files, { dirs: [dir], only: [check.id] });
    expect(result.errors).toEqual([]);
    expect(result.runs.map((run) => run.findings.map((finding) => finding.check_id))).toEqual([[], [check.id]]);
  });
});
