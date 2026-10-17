import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DecisionUnavailableError } from "../src/models/decision.js";
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
    expect(result.results[0]).toMatchObject({ status: "hit" });
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
    expect(result).toMatchObject({ checked: 1, total: 1, skipped: {}, errors: {}, truncated: false });
    expect(result.hits).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "hit" });
    expectFullyAccounted(result);
  });
});
