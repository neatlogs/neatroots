import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { resumeUnfinished } from "../src/engine/engine.js";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { plainToAny, type Plain, type OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await t?.close(); t = undefined; });
const internals = () => t!.roots.engine as unknown as { live: Map<string, unknown> };
const llm = () => span({ traceId: hex(16), name: "chat", kind: "llm" });
function records(sp: OtlpSpan, input?: string, output?: string) {
  return decodeLogsJson({ resourceLogs: [{ resource: batch([sp]).resource, scopeLogs: [{ logRecords: [{ traceId: sp.traceId, spanId: sp.spanId, timeUnixNano: "200", eventName: "gen_ai.client.inference.operation.details", body: plainToAny({ ...(input ? { "gen_ai.input.messages": [{ role: "user", content: input }] } : {}), ...(output ? { "gen_ai.output.messages": [{ role: "assistant", content: output }] } : {}) }) }] }] }] });
}
function mockDecisions() {
  vi.spyOn(t!.roots.decisions, "isSlow").mockResolvedValue(false);
  return vi.spyOn(t!.roots.decisions, "decide").mockImplementation(async (_e, qs) => ({ answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.01, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock", latencyMs: 1 }) as never);
}

it("rechecks selected tool spans when shared goal changes, preserving selectors and goal:false dedupe", async () => {
  t = await makeRoots();
  for (const goal of [true, false]) t.roots.checks.save({ id: `shared-goal-${goal}`, kind: "yes_no", ask: "Are the tool arguments wrong?", scope: "span", when: "live", flag_at: 0.5, evidence: { spans: { type: "TOOL" }, ...(goal ? {} : { goal: false }), fields: ["input", "output"] } }, "user");
  const decide = mockDecisions();
  const base = decide.getMockImplementation()!;
  decide.mockImplementation(async (...args) => {
    const result = await base(...args);
    if (args[1][0].name === "shared-goal-true" && !args[0].includes("new shared instruction")) {
      return { ...result, answers: { "shared-goal-true": { name: "shared-goal-true", type: "yes_no", probability: 0.99, distribution: { yes: 0.99, no: 0.01 } } } } as never;
    }
    return result;
  });
  const sp = llm();
  const tool = span({ traceId: sp.traceId, parent: sp.spanId, name: "lookup", kind: "tool", attrs: [s("input.value", "lookupinput")] });
  t.roots.ingest([batch([sp, tool])]);
  await until(() => decide.mock.calls.some(([, qs]) => qs[0].name === "shared-goal-true"));
  await until(() => t!.roots.store.findingsForTrace(sp.traceId).some((f) => f.check_id === "empty-final-answer"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const stale = t.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "shared-goal-true");
  expect(stale?.status).toBe("raised");
  const before = decide.mock.calls.filter(([, qs]) => qs[0].name === "shared-goal-false").length;
  decide.mockClear();
  t.roots.ingestLogs(records(sp, "new shared instruction"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const changed = decide.mock.calls.filter(([, qs]) => qs[0].name === "shared-goal-true");
  expect(changed).toHaveLength(1);
  expect(changed[0][0]).toContain("new shared instruction");
  expect(changed[0][0]).toContain("lookupinput");
  expect(decide.mock.calls.filter(([, qs]) => qs[0].name === "shared-goal-false")).toHaveLength(0);
  expect(before).toBe(1);
  expect(t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "shared-goal-true").map((d) => d.span_id)).toEqual([tool.spanId, tool.spanId]);
  expect(t.roots.engine!.progress.state(sp.traceId)).toBeUndefined();
  expect(t.roots.store.getFinding(stale!.id)?.status).toBe("resolved");
  decide.mockClear(); t.roots.ingestLogs(records(sp, "new shared instruction"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(decide).not.toHaveBeenCalled();
});

it("retries idle cleanup of a reconstructed completed run while replacement checks stay pending", async () => {
  t = await makeRoots();
  t.roots.checks.save({ id: "held-cleanup", kind: "yes_no", ask: "Is this output wrong?", scope: "trace", when: "end", flag_at: 0.5 }, "user");
  const decide = mockDecisions(); const sp = llm(); t.roots.ingest([batch([sp])]);
  await until(() => decide.mock.calls.some(([, qs]) => qs[0].name === "held-cleanup"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  internals().live.delete(sp.traceId);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const result = decide.getMockImplementation()!;
  decide.mockImplementation(async (...args) => { if (args[1][0].name === "held-cleanup") await held; return result(...args); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    t.roots.ingestLogs(records(sp, undefined, "cleanupanswer"));
    const run = internals().live.get(sp.traceId) as { cleanupTimer?: NodeJS.Timeout };
    const timer = run.cleanupTimer;
    expect(timer).toBeDefined();
    t.roots.ingestLogs(records(sp, undefined, "another cleanupanswer"));
    expect(run.cleanupTimer).toBe(timer);
    await vi.advanceTimersByTimeAsync(301);
    expect(t.roots.engine!.pending(sp.traceId)).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(internals().live.has(sp.traceId)).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.roots.engine!.pending(sp.traceId)).toBe(0);
    expect(internals().live.has(sp.traceId)).toBe(false);
  } finally { release(); vi.useRealTimers(); }
});

it("stops the owned cleanup retry after run replacement or store close", async () => {
  t = await makeRoots(); mockDecisions();
  const sp = llm(); t.roots.ingest([batch([sp])]);
  await until(() => t!.roots.store.findingsForTrace(sp.traceId).some((f) => f.check_id === "empty-final-answer"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  type CleanupRun = { traceId: string; cleanupTimer?: NodeJS.Timeout };
  const engine = t.roots.engine as unknown as { live: Map<string, CleanupRun>; scheduleCleanup(run: CleanupRun): void; pending(id: string): number };
  const original = engine.live.get(sp.traceId)!;
  clearTimeout(original.cleanupTimer);
  original.cleanupTimer = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(engine, "pending").mockReturnValue(1);
  engine.scheduleCleanup(original);
  const replacement = { ...original, cleanupTimer: undefined };
  engine.live.set(sp.traceId, replacement);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(original.cleanupTimer).toBeUndefined();
  expect(engine.live.get(sp.traceId)).toBe(replacement);
  expect(vi.getTimerCount()).toBe(0);
  engine.scheduleCleanup(replacement);
  await t.close(); t = undefined;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(replacement.cleanupTimer).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  engine.scheduleCleanup(replacement);
  expect(vi.getTimerCount()).toBe(0);
});

it("reevaluates memoized user match patterns after same-length operation-details replacement", async () => {
  t = await makeRoots();
  t.roots.checks.save({ id: "same-length", kind: "rule", rule: { type: "match", field: "output", pattern: "bad!" } }, "user");
  const sp = llm(); t.roots.ingest([batch([sp])]);
  t.roots.ingestLogs(records(sp, undefined, "safe"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "same-length")).toHaveLength(0);
  t.roots.ingestLogs(records(sp, undefined, "bad!"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "same-length")).toHaveLength(1);
});

it("does not reuse equal-length match results across stores with identical trace and span IDs", async () => {
  const sp = llm();
  for (const [output, count] of [["safe", 0], ["bad!", 1]] as const) {
    t = await makeRoots(); mockDecisions();
    t.roots.checks.save({ id: "cross-store-match", kind: "rule", rule: { type: "match", field: "output", pattern: "bad!" } }, "user");
    t.roots.ingest([batch([sp])]);
    t.roots.ingestLogs(records(sp, undefined, output));
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "cross-store-match")).toHaveLength(count);
    await t.close(); t = undefined;
  }
});

it("automatically resumes an outstanding marker-only completed receipt through a reopened Roots", async () => {
  t = await makeRoots({ noEngine: true });
  t.roots.checks.save({ id: "marker-resume", kind: "yes_no", ask: "Is the final answer wrong?", scope: "trace", when: "end", flag_at: 0.5 }, "user");
  const sp = llm(); sp.endTimeUnixNano = "0";
  const marker = span({ traceId: sp.traceId, name: "neatlogs.trace.complete", kind: "internal" });
  t.roots.ingest([batch([sp, marker])]);
  t.roots.ingestLogs(records(sp, undefined, "resumedanswer"));
  expect(t.roots.store.getRun(sp.traceId)).toMatchObject({ status: "running", complete: 1, root_ended: 0 });
  const { home, config } = t.roots; t.roots.close(); const reopened = new Roots({ home, config });
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } };
  const decide = mockDecisions();
  expect(await resumeUnfinished(reopened.engine!, reopened)).toBe(1);
  expect(await reopened.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(decide.mock.calls.some(([e, qs]) => qs[0].name === "marker-resume" && e.includes("resumedanswer"))).toBe(true);
  expect(reopened.engine!.progress.state(sp.traceId)).toBeUndefined();
  expect(reopened.store.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
});

it("restores the run's original persisted plan rather than the workflow's newer plan on late content", async () => {
  t = await makeRoots(); const decide = mockDecisions();
  for (const name of ["original", "newer"]) t.roots.checks.save({ id: `${name}-plan-question`, kind: "yes_no", ask: "Is this output wrong?", scope: "trace", when: "end", flag_at: 0.5 }, "db", "planner");
  const sp = llm(); t.roots.ingest([batch([sp])]);
  await until(() => t!.roots.store.findingsForTrace(sp.traceId).some((f) => f.check_id === "empty-final-answer"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const old = t.roots.store.insertPlan({ workflow: "test-agent", created_by: "planner", model: "mock", rationale: "original", check_ids: ["original-plan-question"], params: {}, tools: [] });
  const newer = t.roots.store.insertPlan({ workflow: "test-agent", created_by: "planner", model: "mock", rationale: "newer", check_ids: ["newer-plan-question"], params: {}, tools: [] });
  t.roots.store.db.prepare("UPDATE plans SET created_ms = ? WHERE id = ?").run(old.created_ms + 1, newer.id);
  t.roots.store.setRunPlan(sp.traceId, old.id); internals().live.delete(sp.traceId); decide.mockClear();
  t.roots.ingestLogs(records(sp, undefined, "originalplananswer"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getRun(sp.traceId)?.plan_id).toBe(old.id);
  expect(decide.mock.calls.some(([e, qs]) => qs[0].name === "original-plan-question" && e.includes("originalplananswer"))).toBe(true);
  expect(decide.mock.calls.some(([, qs]) => qs[0].name === "newer-plan-question")).toBe(false);
});
