import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { Roots } from "../src/core.js";
import { resumeUnfinished } from "../src/engine/engine.js";
import { CheckProgress } from "../src/engine/progress.js";
import type { OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, toolSpan, until } from "./helpers.js";

// Startup recovery (resumeUnfinished, 1.5 s after start) is for check work a previous process
// accepted but didn't finish. It also picked up runs this process was checking at that moment,
// rebuilt their live state mid-check, and so dropped an answer still on its way in: the run kept
// the stale one.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const refundCheck = () =>
  parseChecks(`
- id: refund-claimed
  kind: yes_no
  scope: trace
  title: Claimed a refund it did not make
  ask: Did the agent claim a refund it did not make?
  flag_at: 0.5
  evidence: { spans: { type: [llm] } }
`).checks[0];

type Decide = { decide: (e: string, q: { name: string }[], o?: unknown) => Promise<unknown> };

describe("startup recovery", () => {
  it("lets a run this process is checking keep its newest answer", async () => {
    const llm = await mockLlm({});
    const tb = await makeRoots({ serve: true, llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    tb.roots.checks.save(refundCheck(), "user");
    const engine = tb.roots.engine!;
    const decisions = (tb.roots as unknown as { decisions: Decide }).decisions;
    const real = decisions.decide.bind(decisions);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    let asked = 0;
    decisions.decide = async (evidence, questions, o) => {
      if (!questions.some((q) => q.name === "refund-claimed")) return real(evidence, questions, o);
      asked++;
      const newer = evidence.includes("Refund issued: ref 77");
      if (newer) await held;
      order.push(newer ? "newer" : "older");
      return { answers: { "refund-claimed": { probability: newer ? 0.95 : 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 };
    };
    let rechecks = 0;
    const recheck = engine.recheck.bind(engine);
    engine.recheck = (...args: Parameters<typeof recheck>) => {
      rechecks++;
      return recheck(...args);
    };

    const t = hex(16);
    const r = hex(8);
    tb.roots.ingest([batch([llmSpan(t, r, { user: "refund order 1001", out: "Done." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })])]);
    await until(() => order.includes("older"), 5000);
    await engine.waitIdle(t, 5000);
    // A trailing span changes the evidence; its check is held while recovery runs.
    tb.roots.ingest([batch([llmSpan(t, r, { user: "confirm", out: "Refund issued: ref 77" })])]);
    await until(() => asked >= 2, 5000);
    const resumed = resumeUnfinished(engine, tb.roots); // waits for the held check
    release();
    await until(() => order.includes("newer"), 5000);
    await resumed;
    await engine.waitIdle(t, 10_000);

    expect(rechecks).toBe(0); // was 1: recovery rebuilt the live run mid-check
    expect(tb.roots.store.decisionsForTrace(t).filter((d) => d.check_id === "refund-claimed").map((d) => d.probability)).toEqual([0.05, 0.95]); // was [0.05]
    expect(tb.roots.store.findingsForTrace(t).filter((f) => f.check_id === "refund-claimed").map((f) => f.status)).toEqual(["raised"]); // was []
  }, 15_000);

  it("still finishes a run the last process left, when more of its spans arrive first", async () => {
    const llm = await mockLlm({});
    // The last process: a run ended and its checks never finished.
    const before = await makeRoots({ llmUrl: llm.url, noEngine: true });
    const home = (before.roots as unknown as { home: string }).home;
    const config = before.roots.config;
    const t = hex(16);
    const r = hex(8);
    before.roots.ingest([batch([llmSpan(t, r, { user: "refund order 1001", out: "Done." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })])]);
    new CheckProgress(before.roots.store).checking(t);
    before.roots.close();

    // This process: a trailing span of that run arrives before recovery runs.
    const roots = new Roots({ home, config });
    cleanup.push(async () => {
      roots.close();
      fs.rmSync(home, { recursive: true, force: true });
      await llm.close();
    });
    roots.checks.save(refundCheck(), "user");
    const decisions = (roots as unknown as { decisions: Decide }).decisions;
    const real = decisions.decide.bind(decisions);
    decisions.decide = async (evidence, questions, o) =>
      questions.some((q) => q.name === "refund-claimed") ? { answers: { "refund-claimed": { probability: 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 } : real(evidence, questions, o);
    roots.ingest([batch([llmSpan(t, r, { user: "one more", out: "ok" })])]);

    await until(() => roots.engine!.progress.state(t) === undefined, 10_000); // recovery finished it
  }, 15_000);

  it("labels a leftover run's older tool spans when its end arrives before recovery", async () => {
    const llm = await mockLlm({});
    const { roots, runs } = await leftover(llm, (t, r) => [toolSpan(t, r, "lookup", "{}", undefined, "timeout"), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })]);
    const { t, r } = runs[0];
    // The run's completion marker arrives first: a local end pass runs and clears its progress row.
    roots.ingest([batch([markerSpan(t, r)])]);
    await until(() => roots.engine!.progress.state(t) === undefined, 5000);
    await resumeUnfinished(roots.engine!, roots);
    expect(roots.store.decisionsForTrace(t).filter((d) => d.check_id === "neatroots.tool-result")).toHaveLength(1); // was 0
  }, 15_000);

  it("lets a scheduled end pass run before rechecking a leftover run", async () => {
    const llm = await mockLlm({});
    const { roots, runs } = await leftover(llm, (t, r) => [llmSpan(t, r, { user: "hi", out: "ok" }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })]);
    const { t, r } = runs[0];
    const engine = roots.engine! as unknown as { live: Map<string, unknown>; handleEnd: (run: { traceId: string }) => Promise<void> };
    const handleEnd = engine.handleEnd.bind(engine);
    let stale = 0;
    let calls = 0;
    engine.handleEnd = (run) => {
      calls++;
      if (engine.live.get(run.traceId) !== run) stale++;
      return handleEnd(run);
    };
    roots.ingest([batch([markerSpan(t, r)])]); // arms the 400 ms end timer
    await resumeUnfinished(roots.engine!, roots);
    await until(() => calls >= 2, 5000); // the timer's end pass and recovery's
    await roots.engine!.waitIdle(t, 5000);
    expect(stale).toBe(0); // was 1: the timer's end pass ran on the live run recovery had replaced
  }, 15_000);

  it("does not hold other leftover runs behind one whose checks are still running", async () => {
    const llm = await mockLlm({});
    const root = (t: string, r: string) => [llmSpan(t, r, { user: "refund order 1001", out: "Done." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })];
    const { roots, runs } = await leftover(llm, root, 2);
    const [quick, busy] = runs; // unfinished() is newest first, so busy comes first
    const held = holdRefund(roots);
    roots.ingest([batch([llmSpan(busy.t, busy.r, { user: "confirm", out: "Refund issued: ref 77" })])]);
    await until(() => held.asked > 0, 5000);
    const rechecked = spyRecheck(roots);
    const done = resumeUnfinished(roots.engine!, roots);
    await until(() => rechecked.includes(quick.t), 5000); // was: waited for busy's held check first
    expect(rechecked).not.toContain(busy.t);
    held.release();
    await done;
    expect(rechecked).toEqual([quick.t, busy.t]);
  }, 15_000);

  it("resumes a leftover run only once checks that outlast the wait finish", async () => {
    const llm = await mockLlm({});
    const { roots, runs } = await leftover(llm, (t, r) => [llmSpan(t, r, { user: "refund order 1001", out: "Done." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })]);
    const { t, r } = runs[0];
    const held = holdRefund(roots);
    roots.ingest([batch([llmSpan(t, r, { user: "confirm", out: "Refund issued: ref 77" })])]);
    await until(() => held.asked > 0, 5000);
    const rechecked = spyRecheck(roots);
    const done = resumeUnfinished(roots.engine!, roots, 200);
    await sleep(600); // three wait rounds
    expect(rechecked).toEqual([]); // was: rechecked mid-check once the wait ran out
    held.release();
    expect(await done).toBe(1);
    expect(rechecked).toEqual([t]);
  }, 15_000);

  it("waits again for a leftover run whose checks restart while it waits its turn", async () => {
    const llm = await mockLlm({});
    const root = (t: string, r: string) => [llmSpan(t, r, { user: "refund order 1001", out: "Done." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" })];
    const { roots, runs } = await leftover(llm, root, 2);
    const [first, second] = runs;
    const engine = roots.engine!;
    const recheck = engine.recheck.bind(engine);
    let letFirst!: () => void;
    const firstGate = new Promise<void>((r) => (letFirst = r));
    const rechecked: string[] = [];
    let firstDone = false;
    engine.recheck = async (id, opts) => {
      rechecked.push(id);
      if (id !== first.t) return recheck(id, opts);
      await firstGate;
      await recheck(id, opts);
      firstDone = true;
    };
    const done = resumeUnfinished(engine, roots);
    await until(() => rechecked.includes(first.t), 5000); // second is settled and queued behind it
    const held = holdRefund(roots);
    roots.ingest([batch([llmSpan(second.t, second.r, { user: "confirm", out: "Refund issued: ref 77" })])]);
    await until(() => held.asked > 0, 5000);
    letFirst();
    await until(() => firstDone, 5000);
    await new Promise((r) => setImmediate(r)); // second's turn in the queue has run
    expect(rechecked).toEqual([first.t]); // was [first, second]: rechecked mid-check
    held.release();
    await done;
    expect(rechecked).toEqual([first.t, second.t]);
  }, 15_000);

  it("stops waiting on an end pass that a reopened run cancelled", async () => {
    const llm = await mockLlm({});
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;
    const t = hex(16);
    const callerId = hex(8);
    // A callee ends the run through its remote parent, which schedules an end pass.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    expect((engine as unknown as { live: Map<string, { endTimer?: unknown }> }).live.get(t)?.endTimer).toBeDefined();
    const settled = engine.waitSettled(t, 5000);
    // The caller's own span arrives open: the run is running again and that end pass is cancelled.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    expect(await settled).toBe(true);
    expect(tb.roots.store.getRun(t)?.status).toBe("running");
  }, 15_000);
});

/** Opens a store a previous process left with ended runs whose checks never finished. */
async function leftover(llm: { url: string; close: () => Promise<void> }, spans: (t: string, r: string) => OtlpSpan[], n = 1) {
  const before = await makeRoots({ llmUrl: llm.url, noEngine: true });
  const home = (before.roots as unknown as { home: string }).home;
  const config = before.roots.config;
  const progress = new CheckProgress(before.roots.store);
  const runs: { t: string; r: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = hex(16);
    const r = hex(8);
    before.roots.ingest([batch(spans(t, r))]);
    progress.checking(t);
    runs.unshift({ t, r });
    await sleep(5); // distinct updated_ms, so unfinished() order is fixed
  }
  before.roots.close();
  const roots = new Roots({ home, config });
  cleanup.push(async () => {
    roots.close();
    fs.rmSync(home, { recursive: true, force: true });
    await llm.close();
  });
  roots.checks.save(refundCheck(), "user");
  return { roots, runs };
}

/** Holds the newer refund answer until released; other questions go to the mock LLM. */
function holdRefund(roots: Roots) {
  const decisions = (roots as unknown as { decisions: Decide }).decisions;
  const real = decisions.decide.bind(decisions);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { asked: 0, release: () => release() };
  decisions.decide = async (evidence, questions, o) => {
    if (!questions.some((q) => q.name === "refund-claimed")) return real(evidence, questions, o);
    const newer = evidence.includes("Refund issued: ref 77");
    if (newer) {
      state.asked++;
      await gate;
    }
    return { answers: { "refund-claimed": { probability: newer ? 0.95 : 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 };
  };
  return state;
}

/** Records the runs recovery rechecks, in order. */
function spyRecheck(roots: Roots): string[] {
  const engine = roots.engine!;
  const recheck = engine.recheck.bind(engine);
  const ids: string[] = [];
  engine.recheck = (id, opts) => {
    ids.push(id);
    return recheck(id, opts);
  };
  return ids;
}
