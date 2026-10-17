import { afterEach, describe, expect, it } from "vitest";
import { httpTraceToBatches } from "../src/ingest/http-trace.js";
import { checkFromInput } from "../src/server/api.js";
import type { QuestionCheck, RuleCheck } from "../src/checks/types.js";
import { DecisionUnavailableError } from "../src/models/decision.js";
import { makeRoots, mockLlm, type TestRoots } from "./helpers.js";

// A preview used to report one number and no way to find out why: a run it could not judge looked
// exactly like a run it judged and found clean.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(llmOpts: Parameters<typeof mockLlm>[0] = {}) {
  const llm = await mockLlm(llmOpts);
  const tb = await makeRoots({ llmUrl: llm.url });
  cleanup.push(async () => {
    await tb.close();
    await llm.close();
  });
  return { llm, tb };
}

/** A finished run with one tool span and no LLM span: nothing an llm-only selector can read. */
function toolOnlyRun(tb: TestRoots, project = "refund-agent") {
  const { batches, traceId } = httpTraceToBatches({ name: project, project, children: [{ name: "refund", tool_name: "refund", input: "{}", error: "HTTP 500", duration_ms: 10 }], output: "done" });
  tb.roots.ingest(batches);
  return traceId;
}

/** A finished run with one LLM span, so an llm-only selector has something to read. */
function llmRun(tb: TestRoots, project = "refund-agent") {
  const { batches, traceId } = httpTraceToBatches({
    name: project,
    project,
    children: [{ name: "answer", model: "gpt-4", input: "refund 4512", output: "Refunded." }],
    output: "done",
  });
  tb.roots.ingest(batches);
  return traceId;
}

const llmOnlyQuestion = {
  id: "negative-refund",
  kind: "yes_no",
  scope: "span",
  ask: "Did this call pass a negative refund amount?",
  flag_at: 0.8,
  evidence: { spans: { type: ["llm"] } },
} as QuestionCheck;

describe("a preview says which runs it could not judge", () => {
  it("does not count a run the question never looked at as a clean one", async () => {
    const { tb, llm } = await setup();
    toolOnlyRun(tb);
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    // The selector matched nothing, so no question was ever asked.
    expect(llm.requests.filter((x) => x.response_format?.json_schema?.name === "answer")).toHaveLength(0);
    expect(r.checked).toBe(0);
    expect(r.hits).toHaveLength(0);
    expect(r.skipped).toMatchObject({ no_evidence: 1 });
    expect(r.reasons).toEqual([{ trace_id: expect.any(String), reason: "no_evidence", detail: expect.stringMatching(/matched nothing/) }]);
    // The old reading: checked 1, no hits, indistinguishable from an honest negative.
    expect(r.total).toBe(1);
  });

  it("counts a run it really judged, and reports nothing skipped for it", async () => {
    const { tb } = await setup();
    llmRun(tb);
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    expect(r.checked).toBe(1);
    expect(r.skipped).toEqual({});
    expect(r.reasons).toEqual([]);
  });

  it("reports a judge that answered with an error instead of calling it clean", async () => {
    const { tb } = await setup();
    llmRun(tb);
    // A 5xx, 429 or 401 from a hosted judge is a plain Error, not a "no".
    (tb.roots.engine as unknown as { decisions: { decide: () => Promise<never> } }).decisions.decide = () => Promise.reject(new Error("jev HTTP 500: upstream"));
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    expect(r.checked).toBe(0);
    expect(r.skipped).toMatchObject({ model_error: 1 });
    expect(r.reasons[0]).toMatchObject({ reason: "model_error", detail: "jev HTTP 500: upstream" });
  });

  it("still refuses to guess when no decision model is available at all", async () => {
    const { tb } = await setup();
    llmRun(tb);
    (tb.roots.engine as unknown as { decisions: { decide: () => Promise<never> } }).decisions.decide = () => Promise.reject(new DecisionUnavailableError("no decision model available"));
    await expect(tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 })).rejects.toThrow(/no decision model available/);
  });

  it("counts the runs the check does not apply to, so the totals add up", async () => {
    const { tb } = await setup();
    llmRun(tb, "refund-agent");
    llmRun(tb, "search-agent");
    const only = { ...llmOnlyQuestion, applies_to: { project: "refund-agent" } } as QuestionCheck;
    const r = await tb.roots.engine!.previewCheck(only, { limit: 50 });
    expect(r.checked).toBe(1);
    expect(r.skipped).toMatchObject({ not_in_scope: 1 });
    // Every run considered is either judged or skipped, never neither and never both.
    const skippedTotal = Object.values(r.skipped).reduce((n, x) => n + x, 0);
    expect(r.checked + skippedTotal).toBe(2);
  });

  it("says the rate is an upper bound because the preview has no second look", async () => {
    const { tb } = await setup();
    llmRun(tb);
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    expect(r.second_look).toBe(false);
  });

  it("leaves a rule check's result as it was: a rule always ran", async () => {
    const { tb } = await setup();
    toolOnlyRun(tb);
    const rule = checkFromInput(`id: refund-tool-error
kind: rule
title: Refund agent tool failed
rule:
  type: errors
  consecutive: 1
  span:
    type: tool
`).check as RuleCheck;
    const r = await tb.roots.engine!.previewCheck(rule, { limit: 50 });
    expect(r.checked).toBe(1);
    expect(r.skipped).toEqual({});
    expect(r.hits).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it("marks the runs a time budget stopped as aborted, not as clean", async () => {
    const { tb } = await setup();
    llmRun(tb);
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50, timeBudgetMs: -1 });
    expect(r.checked).toBe(0);
    expect(r.skipped).toMatchObject({ aborted: 1 });
    expect(r.reasons[0].detail).toMatch(/ran out of time/);
  });

  it("reports a cancellation that escapes the judge as aborted, not as a model error", async () => {
    const { tb } = await setup();
    llmRun(tb);
    const ac = new AbortController();
    (tb.roots.engine as unknown as { decisions: { decide: () => Promise<never> } }).decisions.decide = () => {
      ac.abort(); // the caller cancelled while the judge was working
      return Promise.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    };
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50, signal: ac.signal });
    expect(r.checked).toBe(0);
    expect(r.skipped).toMatchObject({ aborted: 1 });
    expect(r.reasons[0].reason).toBe("aborted");
  });

  it("reports a judge that rejects with something that isn't an Error as a model error", async () => {
    const { tb } = await setup();
    llmRun(tb);
    const engine = tb.roots.engine as unknown as { decisions: { decide: () => Promise<never> } };
    engine.decisions.decide = () => Promise.reject("boom"); // a string, not an Error
    const r = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    expect(r.checked).toBe(0);
    expect(r.skipped).toMatchObject({ model_error: 1 });
    expect(r.reasons[0]).toMatchObject({ reason: "model_error", detail: "boom" });
    // An empty rejection still names the reason instead of reading as "the evidence matched nothing".
    engine.decisions.decide = () => Promise.reject("");
    const r2 = await tb.roots.engine!.previewCheck(llmOnlyQuestion, { limit: 50 });
    expect(r2.skipped).toMatchObject({ model_error: 1 });
    expect(r2.reasons[0].detail).toBe("the model call failed");
  });
});
