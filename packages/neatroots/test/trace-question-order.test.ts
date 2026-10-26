import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { DecisionUnavailableError } from "../src/models/decision.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, until } from "./helpers.js";

// A trace question can be asked twice at once on a run: new spans change its evidence while the
// first model call is still out, and the next flush asks again. The older call must not write
// last over the newer one's answer (#682).

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** Holds the older call until the test lets it go, so it finishes after the newer call, whatever the timing. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

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

/** The first call is held and answers `older`; a call that sees the second span answers `newer` at once. */
async function race(older: "yes" | "error", newer: "no" | "unavailable" = "no") {
  const llm = await mockLlm({});
  const tb = await makeRoots({ serve: true, llmUrl: llm.url });
  cleanup.push(async () => {
    await tb.close();
    await llm.close();
  });
  tb.roots.checks.save(refundCheck(), "user");
  const decisions = (tb.roots as unknown as { decisions: { decide: (e: string, q: { name: string }[], o?: unknown) => Promise<unknown> } }).decisions;
  const real = decisions.decide.bind(decisions);
  const order: string[] = [];
  const first = gate();
  let asked = 0;
  decisions.decide = async (evidence, questions, o) => {
    if (!questions.some((q) => q.name === "refund-claimed")) return real(evidence, questions, o);
    asked++;
    const isNewer = evidence.includes("Refund issued: ref 77");
    if (!isNewer) await first.held;
    const a = isNewer ? newer : older;
    order.push(isNewer ? "newer" : "older");
    if (a === "unavailable") throw new DecisionUnavailableError("no decision model available");
    if (a === "error") throw new Error("model returned HTTP 500");
    return { answers: { "refund-claimed": { probability: a === "yes" ? 0.95 : 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 };
  };
  const t = hex(16);
  const r = hex(8);
  tb.roots.ingest([batch([llmSpan(t, r, { user: "refund order 1001", out: "I've refunded it." })])]);
  await until(() => asked >= 1);
  // While the first call is out, the evidence changes.
  tb.roots.ingest([batch([llmSpan(t, r, { user: "confirm", out: "Refund issued: ref 77" })])]);
  // The newer call's result is written in microtasks, before this poll's next timer turn: only then let the older go.
  await until(() => order.includes("newer"), 10_000);
  first.release();
  await until(() => order.length >= 2, 10_000);
  await tb.roots.engine!.waitIdle(t, 10_000);
  expect(order).toEqual(["newer", "older"]); // the race happened: the older call finished last
  return {
    statuses: tb.roots.store.findingsForTrace(t).filter((f) => f.check_id === "refund-claimed").map((f) => f.status),
    decisions: tb.roots.store.decisionsForTrace(t).filter((d) => d.check_id === "refund-claimed").map((d) => d.probability),
  };
}

describe("a trace question asked again while its first call is out", () => {
  it("keeps the newer answer when the older call answers yes last", async () => {
    const r = await race("yes");
    expect(r.statuses).toEqual([]); // was ["raised"], on evidence the newer call had answered "no"
    expect(r.decisions).toEqual([0.05]); // was [0.05, 0.95]
  });

  it("records no 'could not run' when the older call fails last", async () => {
    const r = await race("error");
    expect(r.statuses).toEqual([]); // was ["failed"]
    expect(r.decisions).toEqual([0.05]);
  });

  it("drops the older answer when Re-run checks asked again while it was out", async () => {
    const llm = await mockLlm({});
    const tb = await makeRoots({ serve: true, llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    tb.roots.checks.save(refundCheck(), "user");
    const decisions = (tb.roots as unknown as { decisions: { decide: (e: string, q: { name: string }[], o?: unknown) => Promise<unknown> } }).decisions;
    const real = decisions.decide.bind(decisions);
    const order: string[] = [];
    const held = gate();
    let asked = 0;
    decisions.decide = async (evidence, questions, o) => {
      if (!questions.some((q) => q.name === "refund-claimed")) return real(evidence, questions, o);
      const first = ++asked === 1;
      if (first) await held.held;
      order.push(first ? "older" : "recheck");
      return { answers: { "refund-claimed": { probability: first ? 0.95 : 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 };
    };
    const t = hex(16);
    const r = hex(8);
    tb.roots.ingest([batch([llmSpan(t, r, { user: "refund order 1001", out: "Refund issued: ref 77" })])]);
    await until(() => asked >= 1);
    void tb.roots.engine!.recheck(t);
    await until(() => order.includes("recheck"), 10_000);
    held.release();
    await until(() => order.length >= 2, 10_000);
    await tb.roots.engine!.waitIdle(t, 10_000);
    expect(order).toEqual(["recheck", "older"]);
    expect(tb.roots.store.findingsForTrace(t).filter((f) => f.check_id === "refund-claimed").map((f) => f.status)).toEqual([]); // was ["raised"]
  });

  it("keeps the older answer when the newer call found no model", async () => {
    const r = await race("yes", "unavailable");
    expect(r.statuses).toEqual(["raised"]);
    expect(r.decisions).toEqual([0.95]);
  });
});
