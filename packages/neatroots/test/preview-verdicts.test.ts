import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { previewCheck } from "../src/engine/preview.js";
import { flagged } from "../src/engine/engine.js";
import { DecisionUnavailableError, parseJevAnswer } from "../src/models/decision.js";
import type { QuestionCheck, RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, span, toolSpan, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

const question: QuestionCheck = {
  id: "preview-verdicts",
  kind: "yes_no",
  scope: "span",
  ask: "Did the agent do something risky?",
  flag_at: 0.8,
  evidence: { spans: { type: ["llm"] }, fields: ["input"] },
};

function addRun(tb: TestRoots, name: string, includeQuestionEvidence = true): string {
  const traceId = hex(16);
  const rootId = hex(8);
  const spans = [span({ traceId, spanId: rootId, name: `${name}-agent`, kind: "workflow" })];
  spans.push(includeQuestionEvidence
    ? llmSpan(traceId, rootId, { user: name, out: "done" })
    : toolSpan(traceId, rootId, "refund", "{}", undefined, "HTTP 500"));
  tb.roots.ingest([batch(spans)]);
  tb.roots.ingest([batch([markerSpan(traceId, rootId)])]);
  return traceId;
}

function addRunWithQuestionTargets(tb: TestRoots, name: string, targetCount: number): string {
  const traceId = hex(16);
  const rootId = hex(8);
  const spans = [
    span({ traceId, spanId: rootId, name: name + "-agent", kind: "workflow" }),
    ...Array.from({ length: targetCount }, (_, index) => llmSpan(traceId, rootId, { user: name + "-" + index, out: "done" })),
  ];
  tb.roots.ingest([batch(spans)]);
  tb.roots.ingest([batch([markerSpan(traceId, rootId)])]);
  return traceId;
}

function stubDecide(tb: TestRoots, decide: (...args: any[]) => Promise<any>): void {
  const engine = tb.roots.engine as unknown as { decisions: { decide: (...args: any[]) => Promise<any> } };
  engine.decisions.decide = decide;
}

function expectFullyAccounted(result: { checked: number; skipped: Record<string, number>; errors: Record<string, number>; total: number }): void {
  const skipped = Object.values(result.skipped).reduce((sum, count) => sum + count, 0);
  const errors = Object.values(result.errors).reduce((sum, count) => sum + count, 0);
  expect(result.checked + skipped + errors).toBe(result.total);
}

function expectMixed(result: any): void {
  expect(result).toMatchObject({
    second_look: false,
    evaluation_mode: "question_without_second_look",
    checked: 2,
    total: 4,
    hit_rate: 0.5,
    skipped: { no_evidence: 1 },
    errors: { model_error: 1 },
  });
  expect(Array.isArray(result.hits) ? result.hits.length : result.hits).toBe(1);
  expect(result.results).toHaveLength(4);
  expect(result.results.map((r: { status: string }) => r.status).sort()).toEqual(["clear", "error", "hit", "skipped"]);
  expect(result.results.find((r: { status: string }) => r.status === "skipped")).toMatchObject({ reason: "no_evidence" });
  expect(result.results.find((r: { status: string }) => r.status === "error")).toMatchObject({ reason: "model_error" });
  expect(result.results.find((r: { status: string }) => r.status === "error")).not.toHaveProperty("message");
  expectFullyAccounted(result);
}

describe("preview verdict accounting", () => {
  it("does not count a selector miss as checked or call the judge", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRun(tb, "tool-only", false);
    let calls = 0;
    stubDecide(tb, async () => {
      calls++;
      return { answers: { [question.id]: { probability: 0.1 } }, backend: "fixture", model: "fixture" };
    });

    const result = await tb.roots.engine!.previewCheck(question);
    expect(calls).toBe(0);
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual({ no_evidence: 1 });
    expect(result.results[0]).toMatchObject({ status: "skipped", reason: "no_evidence" });
    expectFullyAccounted(result);
  });

  it("reports ordinary judge errors as errors rather than clean negatives", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRun(tb, "judge-error");
    let calls = 0;
    stubDecide(tb, async () => {
      calls++;
      throw new Error("provider detail: token=fixture-secret-not-for-output");
    });

    const result = await tb.roots.engine!.previewCheck(question);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ checked: 0, errors: { model_error: 1 }, skipped: {} });
    expect(result.results[0]).toMatchObject({ status: "error", reason: "model_error" });
    expect(result.results[0]).not.toHaveProperty("message");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-not-for-output");
    expectFullyAccounted(result);
  });

  it("counts every run skipped after a pre-aborted request without calling the judge", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    for (let index = 0; index < 4; index++) addRun(tb, "pre-aborted-" + index);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    stubDecide(tb, async () => { calls++; return { answers: {}, backend: "fixture", model: "fixture" }; });

    const result = await tb.roots.engine!.previewCheck(question, { signal: controller.signal });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ checked: 0, total: 4, skipped: { aborted: 4 }, errors: {}, truncated: true });
    expect(result.results).toHaveLength(4);
    expect(result.results.every((entry) => entry.status === "skipped" && entry.reason === "aborted")).toBe(true);
    expectFullyAccounted(result);
  });

  it("marks the remaining runs skipped when the deterministic time budget expires", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    for (let index = 0; index < 4; index++) addRun(tb, "time-budget-" + index);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    stubDecide(tb, async () => {
      calls++;
      now = 1_011;
      return { answers: { [question.id]: { probability: 0.1 } }, backend: "fixture", model: "fixture" };
    });

    const result = await tb.roots.engine!.previewCheck(question, { timeBudgetMs: 10 });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ checked: 1, total: 4, skipped: { time_budget: 3 }, errors: {}, truncated: true });
    expect(result.results.filter((entry) => entry.status === "skipped")).toHaveLength(3);
    expect(result.results.filter((entry) => entry.status === "skipped").every((entry) => entry.reason === "time_budget")).toBe(true);
    expectFullyAccounted(result);
  });

  it("reports a multi-target clear plus judge error as an error, not a clean negative", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRunWithQuestionTargets(tb, "clear-plus-error", 2);
    let calls = 0;
    stubDecide(tb, async () => {
      calls++;
      if (calls === 1) return { answers: { [question.id]: { probability: 0.1 } }, backend: "fixture", model: "fixture" };
      throw new Error("provider detail: token=fixture-secret-not-for-output");
    });

    const result = await tb.roots.engine!.previewCheck(question);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ checked: 0, total: 1, skipped: {}, errors: { model_error: 1 } });
    expect(result.results[0]).toMatchObject({ status: "error", reason: "model_error" });
    expect(result.results[0]).not.toHaveProperty("message");
    expectFullyAccounted(result);
  });

  it("keeps an observed hit after an earlier ordinary judge error", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRunWithQuestionTargets(tb, "error-before-hit", 3);
    let calls = 0;
    stubDecide(tb, async () => {
      calls++;
      if (calls === 1) throw new Error("provider detail: token=fixture-secret-not-for-output");
      return { answers: { [question.id]: { probability: 0.95 } }, backend: "fixture", model: "fixture" };
    });

    const result = await tb.roots.engine!.previewCheck(question);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ checked: 1, total: 1, skipped: {}, errors: {} });
    expect(result.hits).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "hit", evaluation: {
      targets_available: 3, targets_attempted: 2, targets_evaluated: 1, complete: false, stop_reason: "hit",
    } });
    expectFullyAccounted(result);
  });

  it("keeps DecisionUnavailableError propagation unchanged", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRun(tb, "unavailable");
    const unavailable = new DecisionUnavailableError("decision model unavailable");
    stubDecide(tb, async () => { throw unavailable; });

    await expect(tb.roots.engine!.previewCheck(question)).rejects.toBe(unavailable);
  });

  it("reports a mixed evaluated, skipped and error set through the API and MCP", async () => {
    const tb = await makeRoots({ serve: true });
    cleanup.push(() => tb.close());
    addRun(tb, "hit");
    addRun(tb, "clear");
    addRun(tb, "error");
    addRun(tb, "no-evidence", false);
    const rawError = "provider detail: token=fixture-secret-not-for-output";
    const outcomes: ({ probability: number } | Error)[] = [{ probability: 0.95 }, { probability: 0.1 }, new Error(rawError)];
    let calls = 0;
    stubDecide(tb, async () => {
      const outcome = outcomes[calls++ % outcomes.length];
      if (outcome instanceof Error) throw outcome;
      return { answers: { [question.id]: outcome }, backend: "fixture", model: "fixture" };
    });

    const response = await fetch(`${tb.url}/api/checks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: question, limit: 10 }),
    });
    expect(response.status).toBe(200);
    const apiResult = await response.json();
    expectMixed(apiResult);
    expect(apiResult.truncated).toBe(false);
    expect(JSON.stringify(apiResult)).not.toContain(rawError);
    expect(calls).toBe(3);

    const client = new Client({ name: "preview-verdicts-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
    const toolResult = await client.callTool({ name: "preview_check", arguments: { check: JSON.stringify(question), limit: 10 } });
    const mcpResult = JSON.parse(toolResult.content[0].text);
    expectMixed(mcpResult);
    expect(mcpResult.truncated).toBe(false);
    expect(JSON.stringify(mcpResult)).not.toContain(rawError);
    expect(calls).toBe(6);
    await client.close();
  });

  it("continues to evaluate deterministic rule checks normally", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    addRun(tb, "rule-hit", false);
    const check: RuleCheck = {
      id: "preview-rule",
      kind: "rule",
      rule: { type: "match", span: { type: "tool" }, field: "error", pattern: "HTTP 500" },
    };

    const result = await tb.roots.engine!.previewCheck(check);
    expect(result).toMatchObject({ checked: 1, total: 1, skipped: {}, errors: {}, truncated: false, second_look: false, evaluation_mode: "deterministic_rule" });
    expect(result.hits).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "hit" });
    expectFullyAccounted(result);
  });
});

describe("preview transparency", () => {
  it("reports capped targets without extra decisions or claiming complete evaluation", async () => {
    const tb = await makeRoots(); cleanup.push(() => tb.close());
    addRunWithQuestionTargets(tb, "capped", 7);
    const decide = vi.fn(async () => ({ answers: { [question.id]: { probability: 0.1 } }, backend: "fixture", model: "fixture" }));
    stubDecide(tb, decide);
    const result = await tb.roots.engine!.previewCheck(question);
    expect(decide).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ checked: 1, second_look: false, evaluation_mode: "question_without_second_look" });
    expect(result.results[0]).toMatchObject({ status: "clear", evaluation: {
      targets_available: 7, targets_considered: 5, targets_attempted: 5, targets_evaluated: 5, complete: false, stop_reason: "target_limit",
    } });
  });

  it("reports a short-circuit hit as partial without a second look", async () => {
    const tb = await makeRoots(); cleanup.push(() => tb.close());
    addRunWithQuestionTargets(tb, "early-hit", 3);
    const decide = vi.fn(async () => ({ answers: { [question.id]: { probability: 0.95 } }, backend: "fixture", model: "fixture" }));
    stubDecide(tb, decide);
    const result = await tb.roots.engine!.previewCheck(question);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ status: "hit", evaluation: { targets_available: 3, targets_attempted: 1, complete: false, stop_reason: "hit" } });
  });

  it("records bounded status, scope and limit filtering without leaking request-excluded runs", async () => {
    const tb = await makeRoots(); cleanup.push(() => tb.close());
    const names = ["chosen", "over-limit", "running", "wrong-scope", "private"];
    names.forEach((name, index) => {
      const id = addRun(tb, name);
      tb.roots.store.db.prepare("UPDATE runs SET project = ?, workflow = ?, status = ?, started_ms = ? WHERE trace_id = ?")
        .run(name === "private" ? "private" : "public", name === "wrong-scope" ? "other" : "eligible", name === "running" ? "running" : "ok", 500 - index, id);
    });
    const list = vi.spyOn(tb.roots.store, "listRuns");
    const result = await tb.roots.engine!.previewCheck({ ...question, applies_to: { workflow: "eligible" } }, { project: "public", limit: 1, signal: AbortSignal.abort() });
    expect(list).toHaveBeenCalledWith({ project: "public", workflow: undefined, limit: 500 });
    expect(result.selection).toEqual({ candidate_limit: 500, candidate_count: 4, selected_count: 1, window_full: false });
    expect(result.filtered_results.map((r) => r.reason).sort()).toEqual(["applies_to", "limit", "running"]);
    expect(result.filtered_results).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private-agent");
    expect(result).toMatchObject({ total: 1, checked: 0, skipped: { aborted: 1 } });
    const capped = await tb.roots.engine!.previewCheck(question, { project: "public", limit: 1000000, signal: AbortSignal.abort() });
    expect(capped.selection.candidate_limit).toBe(200);
  });
});

describe("usable preview verdicts", () => {
  const choice: QuestionCheck = { ...question, kind: "choice", options: { good: "Good", bad: "Bad" }, flag_on: ["bad"], flag_at: 0.8 };
  const score: QuestionCheck = { ...question, kind: "score", levels: ["Low", "Medium", "High"], flag_at_level: 1.5 };
  it.each([
    ["missing answer", question, undefined],
    ["null answer", question, null],
    ["missing probability", question, {}],
    ["NaN probability", question, { probability: NaN }],
    ["infinite probability", question, { probability: Infinity }],
    ["negative probability", question, { probability: -0.1 }],
    ["out of range probability", question, { probability: 1.1 }],
    ["missing choice distribution", choice, { probability: 0.5 }],
    ["incomplete choice distribution", choice, { probability: 0.5, distribution: { bad: 0.5 } }],
    ["invalid choice distribution", choice, { probability: 0.5, distribution: { bad: NaN, good: 0.5 } }],
    ["unnormalized choice distribution", choice, { probability: 0.5, distribution: { bad: 0.1, good: 0.1 } }],
    ["missing score", score, { probability: 0.5 }],
    ["invalid score", score, { probability: 0.5, score: NaN }],
    ["out of range score", score, { probability: 0.5, score: 3 }],
  ] as const)("does not call %s a checked negative", async (_name, check, answer) => {
    const tb = await makeRoots(); cleanup.push(() => tb.close());
    addRun(tb, "invalid");
    const decide = vi.fn(async () => ({ answers: { [check.id]: answer }, backend: "fixture", model: "fixture" }));
    stubDecide(tb, decide);
    const result = await tb.roots.engine!.previewCheck(check);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 0, errors: { model_error: 1 } });
    expect(result.results[0]).toMatchObject({ status: "error", reason: "model_error", evaluation: { targets_attempted: 1, targets_evaluated: 0, complete: false } });
    expect(JSON.stringify(result)).not.toContain("unusable preview verdict");
  });
  it.each([
    [choice, { probability: 0.7, distribution: { good: 0.7, bad: 0.3 } }],
    [score, { probability: 0.25, score: 0.5 }],
  ] as const)("accepts a valid $0.kind verdict", async (check, answer) => {
    const tb = await makeRoots(); cleanup.push(() => tb.close()); addRun(tb, "valid");
    stubDecide(tb, async () => ({ answers: { [check.id]: answer }, backend: "fixture", model: "fixture" }));
    const result = await tb.roots.engine!.previewCheck(check);
    expect(result).toMatchObject({ checked: 1, errors: {} });
    expect(result.results[0]).toMatchObject({ status: "clear", evaluation: { targets_evaluated: 1, complete: true } });
  });
  it("accepts and clamps the real parser's nine-option sum roundoff", async () => {
    const tb = await makeRoots(); cleanup.push(() => tb.close()); addRun(tb, "nine-options");
    const options = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), String(i)]));
    const check: QuestionCheck = { ...choice, options, flag_on: Object.keys(options) };
    const answer = parseJevAnswer({ name: check.id, type: "choice", ask: check.ask, options },
      { probabilities: Object.fromEntries(Object.keys(options).map((key) => [key, 1])) });
    const verdict = { answers: { [check.id]: answer }, backend: "fixture", model: "fixture", latencyMs: 0 };
    expect(flagged(check, verdict).probability).toBeGreaterThan(1);
    stubDecide(tb, async () => verdict);
    const result = await tb.roots.engine!.previewCheck(check);
    expect(result).toMatchObject({ checked: 1, errors: {} });
    expect(result.hits[0].probability).toBe(1);
    expect(result.results[0].evaluation).toMatchObject({ targets_evaluated: 1, complete: true });
  });
  it.each([-1e-13, 2 + 1e-13])("clamps score endpoint roundoff %s before flagging", async (value) => {
    const tb = await makeRoots(); cleanup.push(() => tb.close()); addRun(tb, "score-endpoint");
    const decide = vi.fn(async () => ({ answers: { [score.id]: { probability: 1, score: value } }, backend: "fixture", model: "fixture" }));
    const callback = vi.fn((check, result) => flagged(check, result));
    const result = await previewCheck(tb.roots, { decide } as any, score, {}, () => true,
      () => ({ name: score.id, type: "score", ask: score.ask, levels: score.levels }), callback);
    expect(result).toMatchObject({ checked: 1, errors: {} });
    expect(callback.mock.calls[0][1].answers[score.id].score).toBe(value < 0 ? 0 : 2);
  });
  it.each([-0.001, 1.001, NaN, Infinity])("rejects invalid callback probability %s", async (value) => {
    const tb = await makeRoots(); cleanup.push(() => tb.close()); addRun(tb, "bad-callback");
    const decide = vi.fn(async () => ({ answers: { [question.id]: { probability: 0.5 } }, backend: "fixture", model: "fixture" }));
    const result = await previewCheck(tb.roots, { decide } as any, question, {}, () => true,
      () => ({ name: question.id, type: "yes_no", ask: question.ask }), () => ({ flagged: true, probability: value }));
    expect(result).toMatchObject({ checked: 0, errors: { model_error: 1 } });
    expect(result.results[0].evaluation?.targets_evaluated).toBe(0);
  });
  it("does not increment successful targets when the verdict callback throws", async () => {
    const tb = await makeRoots(); cleanup.push(() => tb.close()); addRun(tb, "callback-error");
    const decisions = { decide: vi.fn(async () => ({ answers: { [question.id]: { probability: 0.1 } }, backend: "fixture", model: "fixture" })) };
    const result = await previewCheck(tb.roots, decisions as any, question, {}, () => true,
      () => ({ name: question.id, type: "yes_no", ask: question.ask }), () => { throw new Error("private callback detail"); });
    expect(result).toMatchObject({ checked: 0, errors: { model_error: 1 } });
    expect(result.results[0].evaluation).toMatchObject({ targets_evaluated: 0, complete: false });
    expect(JSON.stringify(result)).not.toContain("private callback detail");
  });
});
