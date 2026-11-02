import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { Roots } from "../src/core.js";
import { CheckProgress } from "../src/engine/progress.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, span, until } from "./helpers.js";

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
    const started = Date.now();
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
    // A trailing span changes the evidence; its check is held until recovery has run.
    tb.roots.ingest([batch([llmSpan(t, r, { user: "confirm", out: "Refund issued: ref 77" })])]);
    await until(() => asked >= 2, 5000);
    expect(Date.now() - started).toBeLessThan(1500); // still before recovery
    await sleep(3000 - (Date.now() - started));
    release();
    await until(() => order.includes("newer"), 5000);
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
});
