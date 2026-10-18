import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, hex, llmSpan, makeRoots, mockLlm, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

const question = { id: "business-rule", ask: "Did the agent break the refund policy?", scope: "trace" };
const malformed: [string, unknown][] = [
  ["null payload", null],
  ["primitive payload", true],
  ["array payload", []],
  ["missing arrays", {}],
  ["null check", { checks: [null], new_questions: [] }],
  ["primitive check", { checks: [42], new_questions: [] }],
  ["nonstring check id", { checks: [{ id: 42 }], new_questions: [] }],
  ["empty check id", { checks: [{ id: " " }], new_questions: [] }],
  ...[null, [], "instruction", { instruction: 42 }, { instruction: null }].map((params, i): [string, unknown] => [
    `invalid params ${i}`, { checks: [{ id: "system-prompt-violation", params }], new_questions: [] },
  ]),
  ["null question", { checks: [], new_questions: [null] }],
  ["primitive question", { checks: [], new_questions: [true] }],
  ["nonstring question id", { checks: [], new_questions: [{ ...question, id: 42 }] }],
  ["nonstring ask", { checks: [], new_questions: [{ ...question, ask: 42 }] }],
  ["short ask", { checks: [], new_questions: [{ ...question, ask: "Why?" }] }],
  ["unsupported session scope", { checks: [], new_questions: [{ ...question, scope: "session" }] }],
  ...["__proto__", "prototype", "constructor"].map((key): [string, unknown] => [
    `reserved parameter ${key}`, { checks: [{ id: "system-prompt-violation", params: JSON.parse(`{"${key}":"value"}`) }], new_questions: [] },
  ]),
  ["invalid scope", { checks: [], new_questions: [{ ...question, scope: "other" }] }],
  ["invalid span type", { checks: [], new_questions: [{ ...question, span_type: [] }] }],
  ["invalid guidance", { checks: [], new_questions: [{ ...question, guidance: {} }] }],
  ["late malformed question", { checks: [], new_questions: [question, null] }],
  ["malformed fourth question", { checks: [], new_questions: [question, question, question, null] }],
  ["nonstring rationale", { rationale: {}, checks: [], new_questions: [] }],
];

async function start(plannerJson: unknown) {
  const llm = await mockLlm({ plannerJson });
  const tb = await makeRoots({ llmUrl: llm.url });
  cleanup.push(async () => { await tb.close(); await llm.close(); });
  const save = vi.spyOn(tb.roots.checks, "save");
  const insertPlan = vi.spyOn(tb.roots.store, "insertPlan");
  const traceId = hex(16), root = hex(8);
  tb.roots.ingest([batch([llmSpan(traceId, root, { user: "Refund order 4512", tools: ["lookup_order"] })])]);
  expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
  return { tb, llm, traceId, root, save, insertPlan };
}

describe("planner payload validation", () => {
  it.each(malformed)("persists one default and no generated checks for %s", async (_name, payload) => {
    const { tb, llm, traceId, root, save, insertPlan } = await start(payload);
    const planId = tb.roots.store.getRun(traceId)?.plan_id;
    expect(planId).toBeTruthy();
    expect(tb.roots.store.getPlan(planId!)?.created_by).toBe("default");
    expect(save).not.toHaveBeenCalled();
    tb.roots.ingest([batch([toolSpan(traceId, root, "lookup_order", "{}", "ok")])]);
    expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    expect(tb.roots.store.getRun(traceId)?.plan_id).toBe(planId);
    expect(insertPlan).toHaveBeenCalledTimes(1);
    expect(llm.requests.filter((r) => r.response_format?.json_schema?.name === "plan")).toHaveLength(1);
  });

  it("preserves valid library parameters and generated span and trace questions", async () => {
    const { tb, traceId, save } = await start({
      rationale: "Checks for refunds",
      checks: [{ id: "system-prompt-violation", params: { instruction: "Confirm ownership first" } }, { id: "unfinished-task" }],
      new_questions: [question, { ...question, id: "tool-policy", scope: "span", span_type: "tool", guidance: "Check ownership." }],
    });
    const plan = tb.roots.store.getPlan(tb.roots.store.getRun(traceId)!.plan_id!)!;
    expect(plan.created_by).toBe("planner");
    expect(plan.params["system-prompt-violation"]).toEqual({ instruction: "Confirm ownership first" });
    expect(plan.check_ids).toContain("unfinished-task");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([check]) => "scope" in check ? check.scope : undefined)).toEqual(["trace", "span"]);
    expect(plan.check_ids).toContain("test-agent.business-rule");
    expect(plan.check_ids).toContain("test-agent.tool-policy");
  });
});
