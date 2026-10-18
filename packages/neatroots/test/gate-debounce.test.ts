import { describe, expect, it, vi } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, toolSpan } from "./helpers.js";

// Gate mode must wait for a trace question that is still in its debounce window.

const QUESTIONS = parseChecks(`
- id: refund-without-lookup
  kind: yes_no
  scope: trace
  title: Refunded without a lookup
  ask: Did the agent issue a refund without looking up the order?
  flag_at: 0.5
  evidence: { spans: { type: [tool] } }
`).checks;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("gate mode", () => {
  it.each([false, true])("waits for a debounced trace question (pending planner: %s)", { timeout: 20_000 }, async (pendingPlanner) => {
    const llm = await mockLlm({ yesWhen: ["refund without looking up"] });
    const tb = await makeRoots({ llmUrl: llm.url });
    const engine = tb.roots.engine!;
    const t = hex(16);
    const root = hex(8);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    // Hold only the first planner continuation; its eventual model request still uses real HTTP.
    const chat = tb.roots.llm.chat.bind(tb.roots.llm);
    if (pendingPlanner) vi.spyOn(tb.roots.llm, "chat").mockImplementation(async (...args) => {
      if (!held && args[1]?.schema?.name === "plan") {
        held = true;
        await barrier;
      }
      return chat(...args);
    });
    let fake = false;
    let settled = false;
    let failed = false;
    try {
      for (const c of QUESTIONS) tb.roots.checks.save(c, "user");
      tb.roots.steering.setMode("test-agent", "gate");
      tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512" })])]);
      if (pendingPlanner) {
        const until = Date.now() + 5000;
        while (!held && Date.now() < until) await tick();
        expect(held, "the controlled planner did not start").toBe(true);
        expect(engine.pending(t)).toBeGreaterThan(0);
      } else {
        expect(await engine.waitIdle(t, 5000), "initial planning did not finish").toBe(true);
      }
      // Keep real HTTP running, but never reach the old 300ms debounce or gate deadline.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fake = true;
      let elapsed = 0;
      tb.roots.ingest([batch([toolSpan(t, root, "issue_refund", '{"order_id":"4512"}', "ok")])]);
      const gate = tb.roots.steering.gate(t, tb.roots.config.steering.gateWaitMs, null).finally(() => (settled = true));
      for (; elapsed < 290 && !settled; elapsed++) {
        vi.advanceTimersByTime(1);
        await tick();
      }
      if (pendingPlanner) {
        expect(settled, "gate returned before the pending planner was released").toBe(false);
        release();
      }
      const until = Date.now() + 10_000;
      while (!settled && Date.now() < until) {
        // Real I/O can enqueue new zero-delay work after the clock has stopped advancing.
        vi.advanceTimersByTime(0);
        await tick();
      }
      expect(elapsed).toBeLessThan(300);
      expect(settled, "gate never returned: the question was left in its debounce").toBe(true);
      const note = await gate;
      expect(engine.pending(t)).toBe(0);
      expect(tb.roots.store.findingsForTrace(t).some((f) => f.check_id === "refund-without-lookup")).toBe(true);
      expect(note?.kind).toBe("llm");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        try {
          release();
          // Cleanup may advance positive time only after assertions, with SQLite still open.
          // Bound gate cancellation and model-job draining; never await a stranded fake timer.
          const until = Date.now() + 5000;
          while ((engine.pending(t) > 0 || (fake && !settled)) && Date.now() < until) {
            if (fake) vi.advanceTimersByTime(10);
            await tick();
          }
          if (engine.pending(t) > 0 || (fake && !settled)) {
            // An active engine job must retain its database until it finishes.
            throw new Error("gate fixture cleanup did not drain within 5000ms; database retained open");
          }
          await tb.close();
          await llm.close();
        } finally {
          vi.restoreAllMocks();
          vi.useRealTimers();
        }
      } catch (error) {
        if (failed) console.error("gate fixture cleanup failed", error);
        else throw error;
      }
    }
  });
});
