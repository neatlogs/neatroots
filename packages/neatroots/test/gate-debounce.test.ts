import { afterEach, describe, expect, it, vi } from "vitest";
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

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("gate mode", () => {
  it("waits for a debounced trace question before the hook's claim", { timeout: 20_000 }, async () => {
    const llm = await mockLlm({ yesWhen: ["refund without looking up"] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    for (const c of QUESTIONS) tb.roots.checks.save(c, "user");
    tb.roots.steering.setMode("test-agent", "gate");
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512" })])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    // Only setTimeout is faked, and the clock stops short of 300 ms: neither the gate's own timeout
    // nor the old 300 ms debounce can fire, while real I/O to the mock LLM runs at its own pace. The
    // gate can only return once the question was flushed straight away, however slow the machine is.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      tb.roots.ingest([batch([toolSpan(t, root, "issue_refund", '{"order_id":"4512"}', "ok")])]);
      let settled = false;
      const gate = tb.roots.steering.gate(t, tb.roots.config.steering.gateWaitMs, null).finally(() => (settled = true));
      const tick = () => new Promise((r) => setImmediate(r));
      for (let ms = 0; ms < 290 && !settled; ms++) {
        vi.advanceTimersByTime(1);
        await tick();
      }
      const until = Date.now() + 10_000;
      while (!settled && Date.now() < until) await tick();
      expect(settled, "gate never returned: the question was left in its debounce").toBe(true);
      const note = await gate;
      expect(tb.roots.engine!.pending(t)).toBe(0);
      expect(tb.roots.store.findingsForTrace(t).some((f) => f.check_id === "refund-without-lookup")).toBe(true);
      expect(note?.kind).toBe("llm");
    } finally {
      vi.useRealTimers();
    }
  });
});
