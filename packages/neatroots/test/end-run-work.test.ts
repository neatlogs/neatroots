import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { loadTrace } from "../src/engine/trace.js";
import { parseChecks } from "../src/checks/registry.js";
import { log } from "../src/util/log.js";
import { batch, hex, makeRoots, span } from "./helpers.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of close.splice(0)) await fn();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(failed = false) {
  const tb = await makeRoots({ noEngine: true });
  close.push(tb.close);
  const traceId = hex(16);
  tb.roots.ingest([batch([span({ traceId, name: "task", kind: "workflow", status: failed ? 2 : 1 })])]);
  const roots = tb.roots;
  const engine = new Engine(roots, roots.llm, roots.decisions, roots.checks, roots.steering);
  const run = engine["liveRun"](traceId)!;
  run.ended = true;
  engine["ensurePlan"] = vi.fn();
  engine["applyRules"] = vi.fn();
  engine.questionsFor = vi.fn().mockReturnValue([]);
  engine["summarize"] = vi.fn().mockResolvedValue(undefined);
  const warning = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  return { engine, run, roots, warning };
}

describe("end-of-run work", () => {
  it("continues after a rejected deferred investigation and still cleans up", async () => {
    const { engine, run, warning } = await setup();
    const remaining = vi.fn().mockResolvedValue(undefined);
    run.deferred.push(async () => { throw new Error("investigation unavailable"); }, remaining);
    vi.useFakeTimers();
    await expect(engine["handleEnd"](run)).resolves.toBeUndefined();
    expect(remaining).toHaveBeenCalledOnce();
    expect(engine["summarize"]).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("investigation unavailable"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine["live"].has(run.traceId)).toBe(false);
  });

  it("continues after a failed whole-run explanation", async () => {
    const { engine, run, roots, warning } = await setup(true);
    vi.spyOn(roots.decisions, "decide").mockResolvedValue({ answers: { triage: { score: 4 } } } as never);
    engine.explainRun = vi.fn().mockRejectedValue(new Error("explanation unavailable"));
    const remaining = vi.fn().mockResolvedValue(undefined);
    run.deferred.push(remaining);
    await expect(engine["handleEnd"](run)).resolves.toBeUndefined();
    expect(remaining).toHaveBeenCalledOnce();
    expect(engine["summarize"]).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("explanation unavailable"));
  });

  it("waits for end-pass triage before draining and summarizing, without waiting for itself", async () => {
    const { engine, run, roots } = await setup();
    const gate = deferred();
    const started = deferred();
    roots.config.budgets.investigationsPerRun = 0;
    const finding = roots.store.insertFinding({ trace_id: run.traceId, check_id: "late", check_kind: "rule", title: "late finding", probability: null, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    vi.spyOn(roots.decisions, "decide").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return { answers: { triage: { score: 4 } } } as never;
    });
    const check = parseChecks("- id: late\n  kind: rule\n  rule: { type: run_end, when: error }\n  title: Late finding\n").checks[0];
    // Only the scheduling contract is relevant here; guidance is off.
    engine["applyRules"] = () => engine["onFindingRaised"](run, finding, { check, source: "user" } as never, {}, loadTrace(roots.store, run.traceId));
    engine.investigate = vi.fn().mockResolvedValue(undefined);
    const ending = engine["track"](run.traceId, engine["handleEnd"](run));
    await started.promise;
    await Promise.resolve();
    expect(engine["summarize"]).not.toHaveBeenCalled();
    gate.resolve();
    await ending;
    expect(engine.investigate).toHaveBeenCalledWith(run.traceId, finding.id);
    expect(run.deferred).toEqual([]);
    expect(engine["summarize"]).toHaveBeenCalledOnce();
    expect(engine.pending(run.traceId)).toBe(0);
  });


  it("does not extend the drain for later triage and does not strand its investigation", async () => {
    const { engine, run, roots } = await setup();
    roots.config.budgets.investigationsPerRun = 0;
    const drainEntered = deferred();
    const drainRelease = deferred();
    const triageRelease = deferred();
    run.deferred.push(async () => { drainEntered.resolve(); await drainRelease.promise; });
    const ending = engine["track"](run.traceId, engine["handleEnd"](run));
    await drainEntered.promise;
    const finding = roots.store.insertFinding({ trace_id: run.traceId, check_id: "late", check_kind: "rule", title: "late finding", probability: null, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    vi.spyOn(roots.decisions, "decide").mockImplementation(async () => {
      await triageRelease.promise;
      return { answers: { triage: { score: 4 } } } as never;
    });
    engine.investigate = vi.fn().mockResolvedValue(undefined);
    const check = parseChecks("- id: late\n  kind: rule\n  rule: { type: run_end, when: error }\n  title: Late finding\n").checks[0];
    engine["onFindingRaised"](run, finding, { check, source: "user" } as never, {}, loadTrace(roots.store, run.traceId));
    drainRelease.resolve();
    await ending;
    expect(engine["summarize"]).toHaveBeenCalledOnce();
    expect(engine.investigate).not.toHaveBeenCalled();
    expect(engine.pending(run.traceId)).toBe(1);
    triageRelease.resolve();
    expect(await engine.waitIdle(run.traceId, 1000)).toBe(true);
    expect(engine.investigate).toHaveBeenCalledWith(run.traceId, finding.id);
    expect(run.deferred).toEqual([]);
  });

  it("still drains work and summarizes after an end-pass error", async () => {
    const { engine, run, warning } = await setup();
    engine["applyRules"] = () => { throw new Error("end checks failed"); };
    const work = vi.fn().mockResolvedValue(undefined);
    run.deferred.push(work);
    await engine["handleEnd"](run);
    expect(work).toHaveBeenCalledOnce();
    expect(engine["summarize"]).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("end checks failed"));
  });

  it("cleans up after late triage outlives the cleanup deadline", async () => {
    const { engine, run, roots } = await setup();
    roots.config.budgets.investigationsPerRun = 0;
    const release = deferred();
    vi.spyOn(roots.decisions, "decide").mockImplementation(async () => {
      await release.promise;
      return { answers: { triage: { score: 4 } } } as never;
    });
    engine.investigate = vi.fn().mockResolvedValue(undefined);
    const finding = roots.store.insertFinding({ trace_id: run.traceId, check_id: "late", check_kind: "rule", title: "late finding", probability: null, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    const check = parseChecks("- id: late\n  kind: rule\n  rule: { type: run_end, when: error }\n  title: Late finding\n").checks[0];
    vi.useFakeTimers();
    await engine["handleEnd"](run);
    engine["onFindingRaised"](run, finding, { check, source: "user" } as never, {}, loadTrace(roots.store, run.traceId));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine["live"].has(run.traceId)).toBe(true);
    release.resolve();
    await Promise.all([...run.triages]);
    expect(engine.investigate).toHaveBeenCalledWith(run.traceId, finding.id);
    expect(engine.pending(run.traceId)).toBe(0);
    expect(engine["live"].has(run.traceId)).toBe(false);
  });
  it("schedules cleanup even if summary itself rejects", async () => {
    const { engine, run } = await setup();
    engine["summarize"] = vi.fn().mockRejectedValue(new Error("summary failed"));
    vi.useFakeTimers();
    await expect(engine["handleEnd"](run)).rejects.toThrow("summary failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine["live"].has(run.traceId)).toBe(false);
  });
});
