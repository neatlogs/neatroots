import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, llmSpan, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
}

const yaml = `
- id: slow-tool-call
  kind: rule
  title: A tool call was slow
  rule:
    type: slow
    span: { type: [tool, mcp_tool] }
    at_least_ms: 2000
  guidance: "{tool} took {ms}ms (limit {limit_ms}ms)."
`;
const parsed = parseChecks(yaml);
const check = parsed.checks[0] as RuleCheck;

function run(st: Store, calls: { tool: string; ms: number }[], llmMs?: number): string {
  const t = hex(16);
  const root = hex(8);
  const spans = [llmSpan(t, root, { user: "go", out: "ok" })];
  if (llmMs) spans.push(span({ traceId: t, parent: root, name: "llm", kind: "llm", durMs: llmMs, attrs: [s("neatlogs.llm.model_name", "mock")] }));
  for (const c of calls) {
    spans.push(span({ traceId: t, parent: root, name: c.tool, kind: "tool", durMs: c.ms, attrs: [s("neatlogs.tool.name", c.tool), s("neatlogs.tool.input", "{}"), s("neatlogs.tool.output", "{}")] }));
  }
  spans.push(span({ traceId: t, spanId: root, name: "root", kind: "workflow", attrs: [s("neatlogs.workflow.output", "done")] }));
  st.ingest([batch(spans)]);
  return t;
}
const hit = (st: Store, t: string) => evaluateRule(check, loadTrace(st, t), true);

describe("slow rule", () => {
  it("parses", () => {
    expect(parsed.errors ?? []).toEqual([]);
    expect(check.rule.type).toBe("slow");
  });

  it("fires on the slowest matching span and reports it", () => {
    const st = store();
    const t = run(st, [{ tool: "search", ms: 300 }, { tool: "export_report", ms: 4500 }, { tool: "lookup", ms: 2100 }]);
    const h = hit(st, t)!;
    expect(h.firing).toBe(true);
    expect(h.params.tool).toBe("export_report");
    expect(h.params.ms).toBe("4500");
    expect(h.params.count).toBe("2");
    expect(h.evidenceSpanIds).toHaveLength(2);
  });

  it("fires exactly at the limit", () => {
    const st = store();
    expect(hit(st, run(st, [{ tool: "a", ms: 2000 }]))?.firing).toBe(true);
  });

  it("stays quiet when every matching span is under the limit", () => {
    const st = store();
    expect(hit(st, run(st, [{ tool: "a", ms: 1999 }, { tool: "b", ms: 10 }]))).toBeNull();
  });

  it("ignores slow spans the selector does not match", () => {
    const st = store();
    expect(hit(st, run(st, [{ tool: "a", ms: 100 }], 9000))).toBeNull();
  });

  it("rejects a non-positive limit", () => {
    const bad = parseChecks(yaml.replace("at_least_ms: 2000", "at_least_ms: 0"));
    expect(bad.checks).toHaveLength(0);
  });
});
