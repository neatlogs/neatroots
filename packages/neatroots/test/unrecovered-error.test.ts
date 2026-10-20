import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, s, span, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const st of stores.splice(0)) st.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  stores.push(st);
  return st;
}
const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const check = lib.find((c) => c.id === "unrecovered-tool-failure")!;

interface Ancestor {
  name: string;
  kind: "agent" | "llm" | "task";
}
interface Step {
  tool: string;
  fail?: boolean;
  /** Shorthand for a direct agent parent, used by the existing root/worker cases. */
  parent?: string;
  /** Ancestors from the root's child down to the tool's direct parent. */
  ancestors?: Ancestor[];
}
/** One run: the given tool calls in order, then a final answer (or none), then the root. */
function run(st: Store, steps: Step[], opts: { answer?: string | null; rootError?: string } = {}): string {
  const t = hex(16);
  const root = hex(8);
  const spans = [llmSpan(t, root, { user: "do the task", out: "ok" })];
  const parents = new Map<string, string>();
  for (const x of steps) {
    let parent = root;
    const ancestors = x.ancestors ?? (x.parent ? [{ name: x.parent, kind: "agent" as const }] : []);
    for (const ancestor of ancestors) {
      const key = JSON.stringify([parent, ancestor.kind, ancestor.name]);
      let id = parents.get(key);
      if (!id) {
        id = hex(8);
        parents.set(key, id);
        spans.push(span({ traceId: t, spanId: id, parent, name: ancestor.name, kind: ancestor.kind }));
      }
      parent = id;
    }
    spans.push(x.fail ? toolSpan(t, parent, x.tool, '{"a":1}', undefined, "HTTP 503 upstream timeout") : toolSpan(t, parent, x.tool, '{"a":1}', '{"ok":true}'));
  }
  const answer = opts.answer === undefined ? "All done, it worked." : opts.answer;
  spans.push(
    span({
      traceId: t,
      spanId: root,
      name: "root",
      kind: "workflow",
      status: opts.rootError ? 2 : 1,
      message: opts.rootError,
      attrs: answer === null ? [] : [s("neatlogs.workflow.output", answer)],
    }),
  );
  st.ingest([batch(spans)]);
  return t;
}
const hit = (st: Store, t: string, atEnd = true) => evaluateRule(check, loadTrace(st, t), atEnd);

describe("unrecovered_error rule", () => {
  it("loads from the library", () => {
    expect(check).toBeDefined();
    expect(check.rule.type).toBe("unrecovered_error");
  });

  it("fires when a tool failed and the run still answered", () => {
    const st = store();
    const t = run(st, [{ tool: "lookup_order" }, { tool: "issue_refund", fail: true }]);
    expect(st.getRun(t)).toMatchObject({ status: "ok", error_count: 1 });
    const h = hit(st, t)!;
    expect(h.firing).toBe(true);
    expect(h.evidenceSpanIds).toHaveLength(1);
    expect(h.params.tool).toBe("issue_refund");
    expect(h.params.tools).toBeUndefined();
    expect(h.params.error).toContain("503");
  });

  it("stays quiet when the same tool succeeded afterwards", () => {
    const st = store();
    const t = run(st, [{ tool: "issue_refund", fail: true }, { tool: "issue_refund" }]);
    expect(hit(st, t)).toBeNull();
  });

  it("uses the enclosing agent or root scope across missing and cyclic ancestry", () => {
    const st = store();
    const sameAgent = run(st, [
      { tool: "issue_refund", fail: true, parent: "worker-a" },
      { tool: "issue_refund", parent: "worker-a" },
    ]);
    expect(hit(st, sameAgent)).toBeNull();

    const rootScope = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "turn-2", kind: "llm" }] },
    ]);
    expect(hit(st, rootScope)).toBeNull();

    const missing = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "turn-2", kind: "llm" }] },
    ]);
    const missingTrace = loadTrace(st, missing);
    missingTrace.spans.find((s) => s.name === "turn-1")!.parentId = "missing-parent-a";
    missingTrace.spans.find((s) => s.name === "turn-2")!.parentId = "missing-parent-b";
    expect(evaluateRule(check, missingTrace, true)).toBeNull();

    const cyclic = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "turn-2", kind: "llm" }] },
    ]);
    const cyclicTrace = loadTrace(st, cyclic);
    const turn1 = cyclicTrace.spans.find((s) => s.name === "turn-1")!;
    const turn2 = cyclicTrace.spans.find((s) => s.name === "turn-2")!;
    turn1.parentId = turn2.id;
    turn2.parentId = turn1.id;
    expect(evaluateRule(check, cyclicTrace, true)).toBeNull();
  });

  it("stays quiet when a retry crosses turn parents inside the same agent", () => {
    const st = store();
    const t = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "worker-a", kind: "agent" }, { name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "worker-a", kind: "agent" }, { name: "turn-2", kind: "llm" }] },
    ]);
    const trace = loadTrace(st, t);
    expect(trace.spans.find((s) => s.name === "worker-a")?.kind).toBe("AGENT");
    expect(trace.spans.find((s) => s.name === "turn-1")?.kind).toBe("LLM");
    expect(trace.spans.find((s) => s.name === "turn-2")?.kind).toBe("LLM");
    expect(hit(st, t)).toBeNull();

    const nested = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "outer", kind: "agent" }, { name: "inner", kind: "agent" }, { name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "outer", kind: "agent" }, { name: "inner", kind: "agent" }, { name: "turn-2", kind: "llm" }] },
    ]);
    const nestedTrace = loadTrace(st, nested);
    expect(nestedTrace.spans.find((s) => s.name === "inner")?.kind).toBe("AGENT");
    expect(nestedTrace.spans.find((s) => s.name === "turn-1")?.kind).toBe("LLM");
    expect(hit(st, nested)).toBeNull();
  });

  it("does not recover across different or nested agent scopes", () => {
    const st = store();
    const t = run(st, [
      { tool: "issue_refund", fail: true, parent: "worker-a" },
      { tool: "issue_refund", parent: "worker-b" },
    ]);
    const h = hit(st, t)!;
    expect(h.firing).toBe(true);
    expect(h.evidenceSpanIds).toHaveLength(1);
    expect(h.params.tool).toBe("issue_refund");

    const nested = run(st, [
      { tool: "issue_refund", fail: true, ancestors: [{ name: "outer", kind: "agent" }, { name: "inner", kind: "agent" }, { name: "turn-1", kind: "llm" }] },
      { tool: "issue_refund", ancestors: [{ name: "outer", kind: "agent" }, { name: "turn-2", kind: "llm" }] },
    ]);
    expect(hit(st, nested)?.firing).toBe(true);
  });

  it("still fires when a different tool succeeded after the failure", () => {
    const st = store();
    const t = run(st, [{ tool: "issue_refund", fail: true }, { tool: "send_email" }]);
    expect(hit(st, t)?.params.tool).toBe("issue_refund");
  });

  it("lists every tool that stayed failed", () => {
    const st = store();
    const t = run(st, [{ tool: "a", fail: true }, { tool: "b", fail: true }, { tool: "c" }]);
    const h = hit(st, t)!;
    expect(h.params.count).toBe("2");
    expect(h.params.tools).toBe("a, b");
  });

  it("waits for the end of the run", () => {
    const st = store();
    const t = run(st, [{ tool: "issue_refund", fail: true }]);
    expect(hit(st, t, false)).toBeNull();
  });

  it("leaves failed or blank-answer runs to the other rules", () => {
    const st = store();
    expect(hit(st, run(st, [{ tool: "x", fail: true }], { rootError: "crashed" }))).toBeNull();
    expect(hit(st, run(st, [{ tool: "x", fail: true }], { answer: "   " }))).toBeNull();
  });

  it("stays quiet when the answer admits the failure", () => {
    const st = store();
    for (const answer of ["Sorry, the refund failed. Please try again later.", "I could not issue the refund.", "Unfortunately the payment service is down."]) {
      expect(hit(st, run(st, [{ tool: "issue_refund", fail: true }], { answer })), answer).toBeNull();
    }
  });

  it("still fires when the answer says nothing went wrong", () => {
    const st = store();
    for (const answer of ["Your refund was processed with no errors.", "Done! Everything went through without any errors.", "Refund complete, no need to try again."]) {
      expect(hit(st, run(st, [{ tool: "issue_refund", fail: true }], { answer }))?.firing, answer).toBe(true);
    }
    expect(hit(st, run(st, [{ tool: "issue_refund", fail: true }], { answer: "No errors were logged, but the refund failed." }))).toBeNull();
  });

  it("ignores runs with no tool calls and clean runs", () => {
    const st = store();
    expect(hit(st, run(st, []))).toBeNull();
    expect(hit(st, run(st, [{ tool: "a" }, { tool: "b" }]))).toBeNull();
  });

  it("smoke run: 120 generated runs, every verdict matches the label", () => {
    const st = store();
    const tools = ["lookup_order", "issue_refund", "send_email", "search_docs", "create_ticket", "get_user"];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const claims = ["All done, it worked.", "Your request is complete.", "Refund issued, you will see it in 3-5 days.", "Ticket created and the customer was notified."];
    const honest = ["Sorry, that step failed, please try again.", "I was unable to finish this.", "Unfortunately an error came back, nothing was changed."];
    const counts = { fire: 0, quiet: 0, honestFailures: 0 };
    for (let i = 0; i < 120; i++) {
      const steps: Step[] = [];
      const n = rnd(5);
      for (let j = 0; j < n; j++) steps.push({ tool: tools[rnd(tools.length)], fail: rnd(3) === 0 });
      // Expected by definition: the last call of some tool is a failure.
      const lastByTool = new Map<string, boolean>();
      for (const x of steps) lastByTool.set(x.tool, !!x.fail);
      const unrecovered = [...lastByTool.values()].some(Boolean);
      const admits = rnd(3) === 0;
      const answer = admits ? honest[rnd(honest.length)] : claims[rnd(claims.length)];
      const expected = unrecovered && !admits;
      if (unrecovered && admits) counts.honestFailures++;
      const h = hit(st, run(st, steps, { answer }));
      expect(!!h?.firing, `case ${i}: ${JSON.stringify(steps)}`).toBe(expected);
      counts[expected ? "fire" : "quiet"]++;
    }
    expect(counts.fire).toBeGreaterThan(20);
    expect(counts.quiet).toBeGreaterThan(20);
    expect(counts.honestFailures).toBeGreaterThan(5);
  });
});
