import { afterEach, describe, expect, it } from "vitest";
import { buildEvidence, loadTrace } from "../src/engine/trace.js";
import { quoteInEvidence } from "../src/engine/verify.js";
import { shrinkDistribution } from "../src/models/decision.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, toolSpan, until, type TestRoots } from "./helpers.js";

// Fewer, more honest findings: what a question about one LLM call sees, how sure an LLM answer
// may claim to be, the second look before raising, one finding per run, groups, and quiet checks.

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

const SYSTEM = "You are a shopping assistant. Always call plan_search before inspect_products.";

/** plan_search, then search_products, then an LLM call that inspects products: a healthy order. */
function orderedRun(tb: TestRoots) {
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: SYSTEM, user: "Find running shoes under $100", toolCalls: [{ name: "plan_search", args: '{"q":"running shoes"}' }], tools: ["plan_search", "search_products", "inspect_products"] })])]);
  tb.roots.ingest([batch([toolSpan(t, root, "plan_search", '{"q":"running shoes"}', '{"plan":"filter by price"}')])]);
  tb.roots.ingest([batch([toolSpan(t, root, "search_products", '{"max_price":100}', '{"ids":["p1","p2"]}')])]);
  tb.roots.ingest([batch([llmSpan(t, root, { system: SYSTEM, user: "Find running shoes under $100", toolCalls: [{ name: "inspect_products", args: '{"ids":["p1","p2"]}' }] })])]);
  return { t, root };
}

describe("what a question about one LLM call sees", () => {
  it("includes the tool calls made earlier in the run, so an ordering rule can be judged", async () => {
    const { tb } = await setup();
    const { t } = orderedRun(tb);
    const snap = loadTrace(tb.roots.store, t);
    const last = snap.spans.filter((s) => s.kind === "LLM").at(-1)!;
    const ev = buildEvidence(snap, { spans: { type: "llm" }, fields: ["input", "output"] }, { focus: last }).text;
    expect(ev).toMatch(/Tool calls earlier in this run[\s\S]*plan_search ok[\s\S]*search_products ok/);
    // The system prompt is stated once, not repeated as the head of the call's input.
    expect(ev.split("Always call plan_search").length - 1).toBe(1);
  });

  it("says when nothing ran before", async () => {
    const { tb } = await setup();
    const { t } = orderedRun(tb);
    const snap = loadTrace(tb.roots.store, t);
    const first = snap.spans.find((s) => s.kind === "LLM")!;
    expect(buildEvidence(snap, undefined, { focus: first }).text).toContain("Tool calls earlier in this run: none.");
  });
});

describe("how sure an LLM answer may claim to be", () => {
  it("pulls an LLM's own probability toward even odds, topping out at 90%", () => {
    expect(shrinkDistribution({ yes: 1, no: 0 }).yes).toBeCloseTo(0.9);
    expect(shrinkDistribution({ yes: 0.5, no: 0.5 }).yes).toBeCloseTo(0.5);
    expect(shrinkDistribution({ yes: 0, no: 1 }).yes).toBeCloseTo(0.1);
  });
});

describe("the second look before raising", () => {
  it("accepts a quote only if it is really in the evidence", () => {
    const ev = 'output: {"reply":"Your refund of $40 has been issued."}';
    expect(quoteInEvidence("Your refund of $40 has been issued", ev)).toBe(true);
    expect(quoteInEvidence("Your refund of $40… been issued", ev)).toBe(true);
    expect(quoteInEvidence("The order was cancelled", ev)).toBe(false);
    expect(quoteInEvidence("ok", ev)).toBe(false);
  });

  it("raises nothing when the second look doesn't confirm the flag", async () => {
    const { tb, llm } = await setup({ yesWhen: ["carry on as if a tool call had succeeded"], rejectWhen: ["carry on"] });
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }], tools: ["lookup_order"] })])]);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "continue", out: "Refunded order 4512." })])]);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    await until(() => tb.roots.store.getSummary(t), 15000);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.decisionsForTrace(t).some((d) => d.check_id === "ignored-tool-error" && (d.probability ?? 0) > 0.8)).toBe(true);
    expect(llm.requests.some((r) => r.response_format?.json_schema?.name === "verification")).toBe(true);
    expect(tb.roots.store.findingsForTrace(t).find((f) => f.check_id === "ignored-tool-error")).toBeUndefined();
  });
});

describe("one finding per run for a question about single LLM calls", () => {
  it("adds later calls that show the problem to the first finding", async () => {
    const { tb } = await setup({
      yesWhen: ["break an instruction"],
      plan: [{ id: "system-prompt-violation", params: { instruction: "Always call plan_search before inspect_products" } }],
    });
    const t = hex(16);
    const root = hex(8);
    const asked = () => tb.roots.store.decisionsForTrace(t).filter((d) => d.check_id === "system-prompt-violation").length;
    // One call at a time: with the LLM standing in, only the newest waiting call is asked.
    for (let i = 0; i < 3; i++) {
      tb.roots.ingest([batch([llmSpan(t, root, { system: SYSTEM, user: `step ${i}`, out: `reply ${i}`, tools: ["plan_search", "inspect_products"] })])]);
      await until(() => asked() > i, 15000);
    }
    const f = await until(() => {
      const all = tb.roots.store.findingsForTrace(t).filter((x) => x.check_id === "system-prompt-violation");
      return all.length && (all[0].detail.occurrences as string[] | undefined)?.length === 2 ? all : undefined;
    });
    expect(f).toHaveLength(1);
    expect(f[0].detail.quote).toBeTruthy();
    expect(tb.roots.store.getRun(t)!.open_finding_count).toBe(1);
  });
});

describe("findings that describe one incident", () => {
  it("count once when checks in the same group fire on the same loop", async () => {
    const { tb } = await setup();
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }], tools: ["lookup_order"] })])]);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404: not found")])]);
    const fs = await until(() => {
      const all = tb.roots.store.findingsForTrace(t).filter((f) => f.status === "raised");
      return all.some((f) => f.check_id === "repeated-tool-call") && all.some((f) => f.check_id === "tool-error-streak") ? all : undefined;
    });
    expect(fs.filter((f) => f.detail.group === "loop").length).toBeGreaterThanOrEqual(2);
    expect(tb.roots.store.getRun(t)!.open_finding_count).toBe(1);
  });
});

describe("a check the person keeps dismissing", () => {
  it("goes quiet in that project after three dismissals: recorded, not counted", async () => {
    const { tb } = await setup();
    const loop = () => {
      const t = hex(16);
      const root = hex(8);
      tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", tools: ["lookup_order"] })])]);
      for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', '{"ok":true}')])]);
      return t;
    };
    for (let n = 0; n < 3; n++) {
      const t = loop();
      const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
      tb.roots.store.updateFinding(f.id, { status: "dismissed" });
    }
    const t = loop();
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
    expect(f.status).toBe("quiet");
    expect(tb.roots.store.getRun(t)!.open_finding_count).toBe(0);
    // It isn't raised again on the next span either.
    tb.roots.ingest([batch([toolSpan(t, hex(8), "lookup_order", '{"order_id":"4512"}', '{"ok":true}')])]);
    await tb.roots.engine!.waitIdle(t, 3000);
    expect(tb.roots.store.findingsForTrace(t).filter((x) => x.check_id === "repeated-tool-call")).toHaveLength(1);
  });
});
