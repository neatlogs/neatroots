import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule, fillTemplate } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { heuristicToolLabel } from "../src/engine/engine.js";
import { batch, closeTrackedStores, hex, llmSpan, s, span, tmpHome, toolSpan, trackedStore } from "./helpers.js";

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
const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = (id: string) => lib.find((c) => c.id === id)!;

describe("rules", () => {
  it("loads the whole library without errors", () => {
    for (const f of ["rules.yaml", "questions.yaml"]) {
      const r = parseChecks(fs.readFileSync(new URL(`../library/${f}`, import.meta.url), "utf8"));
      expect(r.errors).toEqual([]);
      expect(r.checks.length).toBeGreaterThan(5);
    }
  });

  it("repeat fires on the third identical call and resolves when the agent changes course", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    st.ingest([batch([toolSpan(t, root, "lookup_order", '{"id":"1"}', undefined, "404"), toolSpan(t, root, "lookup_order", '{"id":"1"}', undefined, "404")])]);
    expect(evaluateRule(rule("repeated-tool-call"), loadTrace(st, t), false)).toBeNull();
    st.ingest([batch([toolSpan(t, root, "lookup_order", '{"id":"1"}', undefined, "404")])]);
    const hit = evaluateRule(rule("repeated-tool-call"), loadTrace(st, t), false)!;
    expect(hit.firing).toBe(true);
    expect(hit.evidenceSpanIds).toHaveLength(3);
    expect(hit.params).toMatchObject({ tool: "lookup_order", count: "3", args: '{"id":"1"}' });
    st.ingest([batch([toolSpan(t, root, "lookup_order", '{"id":"2"}', '{"ok":true}')])]);
    const later = evaluateRule(rule("repeated-tool-call"), loadTrace(st, t), false)!;
    expect(later.firing).toBe(false);
  });

  it("errors, count, threshold, match and run_end", () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    const spans = [toolSpan(t, root, "a", "{}", undefined, "boom"), toolSpan(t, root, "b", "{}", undefined, "boom"), toolSpan(t, root, "c", "{}", undefined, "boom")];
    st.ingest([batch([...spans, llmSpan(t, root, { user: "hi", out: "here is sk-abcdefghijklmnopqrstuvwxyz123456" })])]);
    const snap = loadTrace(st, t);
    expect(evaluateRule(rule("tool-error-streak"), snap, false)?.params.count).toBe("3");
    expect(evaluateRule(rule("secret-in-output"), snap, false)?.firing).toBe(true);
    expect(evaluateRule({ ...rule("runaway-loop"), rule: { type: "count", span: { type: "llm" }, at_least: 1 } } as RuleCheck, snap, false)?.params.count).toBe("1");
    expect(evaluateRule({ ...rule("token-budget"), rule: { type: "threshold", metric: "total_tokens", at_least: 10 } } as RuleCheck, snap, false)?.firing).toBe(true);
    expect(evaluateRule(rule("run-failed"), snap, false)).toBeNull();
    st.ingest([batch([span({ traceId: t, spanId: root, name: "root", kind: "workflow", status: 2, message: "crashed" })])]);
    expect(evaluateRule(rule("run-failed"), loadTrace(st, t), true)?.params.error).toContain("crashed");
  });

  it("empty-final-answer fires for a root with no output", () => {
    const st = store();
    const t = hex(16);
    st.ingest([batch([span({ traceId: t, name: "root", kind: "workflow", attrs: [s("neatlogs.workflow.output", '""')] })])]);
    expect(evaluateRule(rule("empty-final-answer"), loadTrace(st, t), true)?.firing).toBe(true);
  });

  it("fills templates and labels tool results", () => {
    expect(fillTemplate("Called {tool} {count} times ({args}).", { tool: "x", count: "3", args: "{}" })).toBe("Called x 3 times ({}).");
    expect(fillTemplate("Hi {missing}.", {})).toBe("Hi .");
    const ask = 'Does this reply break an instruction[[, namely "{instruction}"]]?';
    expect(fillTemplate(ask, { instruction: "Never share keys" })).toBe('Does this reply break an instruction, namely "Never share keys"?');
    expect(fillTemplate(ask, {})).toBe("Does this reply break an instruction?");
    // Parens that come from a value are part of what the agent did, so they stay;
    // only the template's own "()" left by an empty value is removed.
    const same = "Called {tool} {count} times with the same arguments ({args}).";
    expect(fillTemplate(same, { tool: "run_code", count: "3", args: "print()" })).toBe("Called run_code 3 times with the same arguments (print()).");
    expect(fillTemplate("Result: {result}", { result: "count() + now()" })).toBe("Result: count() + now()");
    expect(fillTemplate(same, { tool: "x", count: "3", args: "" })).toBe("Called x 3 times with the same arguments .");
    const base = { id: "a", ref: "a", parentId: null, name: "t", kind: "TOOL" as const, startMs: 0, endMs: 1, durationMs: 1, seq: 1 };
    expect(heuristicToolLabel({ ...base, status: "error" })).toBe("error");
    expect(heuristicToolLabel({ ...base, status: "ok", output: [] })).toBe("empty");
    expect(heuristicToolLabel({ ...base, status: "ok", output: { rows: [1] } })).toBe("success");
    expect(heuristicToolLabel({ ...base, status: "ok", output: { message: "Order not found" } })).toBeUndefined();
  });
});

describe("final answer", () => {
  it("treats an empty last LLM reply as no answer", async () => {
    const st = store();
    const t = hex(16);
    const root = hex(8);
    st.ingest([
      batch([
        llmSpan(t, root, { user: "refund 1001", out: "" }),
        span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.output", "null")] }),
      ]),
    ]);
    expect(evaluateRule(rule("empty-final-answer"), loadTrace(st, t), true)?.firing).toBe(true);
  });
});
