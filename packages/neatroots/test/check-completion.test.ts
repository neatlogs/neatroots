import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { Roots } from "../src/core.js";
import { batch, hex, makeRoots, mockLlm, s, span, toolSpan, until } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const llm = await mockLlm();
  cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url });
  cleanup.push(t.close);
  const trace = hex(16);
  const root = span({ traceId: trace, name: "completed", kind: "workflow", attrs: [
    s("neatlogs.workflow.input", "Complete the task"), s("neatlogs.workflow.output", "Done"),
  ] });
  return { t, trace, root, input: batch([root]) };
}

describe("engine-owned completion receipts", () => {
  it("keeps identical retransmissions settled, including after a process restart", async () => {
    const { t, trace, input } = await setup();
    t.roots.ingest([input]);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    const update = t.roots.ingest([input])[0];
    expect(update.spans[0].isChanged).toBe(false);
    expect(t.roots.checkCompletion.state(trace)).toBe("settled");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
    t.roots.close();
    const reopened = new Roots({ home: t.roots.home, config: t.roots.config });
    cleanup.push(() => reopened.close());
    reopened.ingest([input]);
    expect(reopened.checkCompletion.state(trace)).toBe("settled");
    expect(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM replay_batches").get()).toEqual({ n: 0 });
  });

  it("makes changed completed evidence visibly require recheck, then evaluates it freshly", async () => {
    const { t, trace, root, input } = await setup();
    t.roots.ingest([input]);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    const changed = { ...root, attributes: [...root.attributes, s("new.evidence", "changed")] };
    expect(t.roots.ingest([batch([changed])])[0].spans[0].isChanged).toBe(true);
    expect(t.roots.checkCompletion.state(trace)).toBe("pending");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(true);
    expect(t.roots.engine!.progress.state(trace)).toBe("interrupted");
    await t.roots.engine!.recheck(trace);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
  });

  it("does not let an in-flight old end pass certify a late span", async () => {
    const { t, trace, root, input } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(() => release());
    let entered = false;
    const spy = vi.spyOn(t.roots.engine! as unknown as { summarize(): Promise<void> }, "summarize")
      .mockImplementation(async () => { entered = true; await gate; });
    t.roots.ingest([input]);
    await until(() => entered);
    t.roots.ingest([batch([toolSpan(trace, root.spanId, "late", "{}", "new result")])]);
    release();
    await until(() => !t.roots.engine!.pending(trace));
    expect(t.roots.checkCompletion.state(trace)).toBe("pending");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(true);
    spy.mockRestore();
    await t.roots.engine!.recheck(trace);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
  });

  it("resets failed and ended before recheck starts either phase", async () => {
    const { t, trace, input } = await setup();
    const failure = vi.spyOn(t.roots.decisions, "decide").mockRejectedValue(new Error("mock check failure"));
    t.roots.ingest([input]);
    await until(() => t.roots.checkCompletion.hasEnded(trace) && !t.roots.engine!.pending(trace));
    expect(t.roots.checkCompletion.state(trace)).toBe("failed");
    failure.mockRestore();
    const engine = t.roots.engine! as unknown as { handleSpans(...args: unknown[]): Promise<void> };
    const original = engine.handleSpans.bind(engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(() => release());
    const spy = vi.spyOn(engine, "handleSpans").mockImplementation(async (...args) => { await gate; await original(...args); });
    const recheck = t.roots.engine!.recheck(trace);
    expect(t.roots.checkCompletion.state(trace)).toBe("pending");
    expect(t.roots.checkCompletion.hasEnded(trace)).toBe(false);
    release();
    await recheck;
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    spy.mockRestore();
  });
  it("automatically checks a completed replacement of a provisional root", async () => {
    const { t, trace, root } = await setup();
    const provisional = { ...root, endTimeUnixNano: "0", status: { code: 0 },
      attributes: root.attributes.filter((a) => a.key !== "neatlogs.workflow.output") };
    t.roots.ingest([batch([provisional])]);
    await until(() => !!t.roots.store.getRun(trace)?.plan_id);
    await until(() => !t.roots.engine!.pending(trace));
    expect(t.roots.store.getRun(trace)?.status).toBe("running");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
    const update = t.roots.ingest([batch([root])]);
    expect(update[0].spans[0]).toMatchObject({ isNew: false, isChanged: true });
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
    expect(t.roots.store.getRun(trace)).toMatchObject({ status: "ok", span_count: 1 });
    expect(t.roots.engine!.progress.state(trace)).toBeUndefined();
  });

  it("reevaluates a live tool replacement and discards its superseded in-flight answer", async () => {
    const { t, trace, root } = await setup();
    t.roots.checks.save(parseChecks(`id: live-value
kind: yes_no
title: Live value
scope: span
when: live
ask: Does the tool output contain the old bad value?
evidence:
  spans: { type: tool }
  fields: [output]
flag_at: 0.8
`).checks[0], "user");
    const decide = t.roots.decisions.decide.bind(t.roots.decisions);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(() => release());
    let oldStarted = false;
    vi.spyOn(t.roots.decisions, "decide").mockImplementation(async (text, questions, options) => {
      const q = questions.find((question) => question.name === "live-value");
      if (!q) return decide(text, questions, options);
      const old = text.includes("OLD_BAD");
      if (old) { oldStarted = true; await gate; }
      const probability = old ? 0.99 : 0.01;
      return { answers: { [q.name]: { name: q.name, type: "yes_no", probability, distribution: { yes: probability, no: 1 - probability } } },
        backend: "llm", model: "mock", latencyMs: 0 };
    });
    const provisional = { ...root, endTimeUnixNano: "0", status: { code: 0 },
      attributes: root.attributes.filter((a) => a.key !== "neatlogs.workflow.output") };
    const tool = toolSpan(trace, root.spanId, "lookup", "{}", "OLD_BAD");
    t.roots.ingest([batch([provisional, tool])]);
    await until(() => oldStarted);
    const updated = { ...tool, attributes: tool.attributes.map((a) => a.key === "neatlogs.tool.output" ? s(a.key, "NEW_GOOD") : a) };
    t.roots.ingest([batch([updated])]);
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
    release();
    await until(() => t.roots.store.decisionsForTrace(trace).some((d) => d.check_id === "live-value" && d.probability === 0.01));
    expect(t.roots.store.decisionsForTrace(trace).filter((d) => d.check_id === "live-value").every((d) => d.probability === 0.01)).toBe(true);
    expect(t.roots.store.findingsForTrace(trace).some((f) => f.check_id === "live-value")).toBe(false);
    t.roots.ingest([batch([root])]);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    expect(t.roots.checkCompletion.requiresRecheck(trace)).toBe(false);
    expect(t.roots.engine!.progress.state(trace)).toBeUndefined();
  });

  it("keeps a rejected busy span queue out of settled and clean batch counts", async () => {
    const { t, trace, input } = await setup();
    t.roots.ingest([input]);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    t.roots.checks.save(parseChecks(`id: queue-check
kind: yes_no
title: Queue check
scope: span
when: live
ask: Does this tool show an impossible failure?
evidence:
  spans: { type: tool }
  fields: [output]
flag_at: 0.8
`).checks[0], "user");
    let reject!: (error: Error) => void;
    const gate = new Promise<boolean>((_, fail) => { reject = fail; });
    let held = false;
    const isSlow = t.roots.decisions.isSlow.bind(t.roots.decisions);
    const spy = vi.spyOn(t.roots.decisions, "isSlow").mockImplementation((questions) => {
      if (!questions?.some((q) => q.name === "queue-check")) return isSlow(questions);
      if (!held) { held = true; return gate; }
      return Promise.resolve(false);
    });
    let produced = "";
    const server = http.createServer(async (req, res) => {
      let text = "";
      for await (const part of req) text += part;
      const id = JSON.parse(text).replay_id;
      produced = hex(16);
      const rootId = hex(8);
      const send = (spans: ReturnType<typeof span>[]) => {
        const b = batch(spans);
        b.resource.attributes.push(s("neatroots.replay.id", id));
        t.roots.ingest([b]);
      };
      send([toolSpan(produced, rootId, "first", "{}", "one")]);
      await until(() => held);
      send([toolSpan(produced, rootId, "second", "{}", "two"), span({ traceId: produced, spanId: rootId,
        name: "complete", kind: "workflow", attrs: [s("neatlogs.workflow.input", "Task"), s("neatlogs.workflow.output", "Done")] })]);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    t.roots.config.rerun["test-agent"] = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
    const { batch: b, done } = t.roots.replayBatches.start(trace, 1);
    await until(() => produced && t.roots.checkCompletion.hasEnded(produced));
    expect(t.roots.checkCompletion.state(produced)).toBe("pending");
    expect(t.roots.replayBatches.get(b.id)?.clean).toBe(0);
    reject(new Error("controlled old isSlow rejection"));
    await until(() => t.roots.checkCompletion.state(produced) === "failed");
    expect(t.roots.engine!.pending(produced)).toBeGreaterThan(0);
    expect(await done).toMatchObject({ settled: 0, clean: 0, evaluation_failed: 1 });
    // Keep the fast-backend fixture through recovery so both accepted spans are checked.
    await t.roots.engine!.recheck(produced);
    await until(() => t.roots.checkCompletion.state(produced) === "settled");
    expect(t.roots.store.decisionsForTrace(produced).filter((d) => d.check_id === "queue-check")).toHaveLength(2);
    spy.mockRestore();
  }, 15_000);

  it("refuses settlement for late deferred triage without blocking waitIdle", async () => {
    const { t, trace, root } = await setup();
    t.roots.config.budgets.investigationsPerRun = 0;
    t.roots.checks.save(parseChecks(`id: deferred-problem
kind: rule
title: Deferred problem
rule:
  type: match
  span: { type: tool }
  field: output
  pattern: problem
`).checks[0], "user");
    let releaseTriage!: () => void;
    let releaseSummary!: () => void;
    const triageGate = new Promise<void>((resolve) => { releaseTriage = resolve; });
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    cleanup.push(() => { releaseTriage(); releaseSummary(); });
    const decide = t.roots.decisions.decide.bind(t.roots.decisions);
    vi.spyOn(t.roots.decisions, "decide").mockImplementation(async (text, questions, options) => {
      if (!questions.some((q) => q.name === "triage")) return decide(text, questions, options);
      await triageGate;
      return { answers: { triage: { name: "triage", type: "score", probability: 1, score: 4, distribution: { "4": 1 } } },
        backend: "llm", model: "mock", latencyMs: 0 };
    });
    let summarizing = false;
    const engine = t.roots.engine! as unknown as {
      summarize(): Promise<void>;
      live: Map<string, { deferred: unknown[] }>;
    };
    vi.spyOn(engine, "summarize").mockImplementation(async () => { summarizing = true; await summaryGate; });
    const investigate = vi.spyOn(t.roots.engine!, "investigate").mockResolvedValue(undefined);
    t.roots.ingest([batch([root, toolSpan(trace, root.spanId, "flag", "{}", "problem")])]);
    await until(() => summarizing);
    const run = engine.live.get(trace)!;
    expect(run.deferred).toHaveLength(0);
    releaseTriage();
    await until(() => run.deferred.length === 1);
    releaseSummary();
    await until(() => t.roots.checkCompletion.hasEnded(trace) && t.roots.engine!.pending(trace) === 0);
    expect(investigate).not.toHaveBeenCalled();
    expect(t.roots.checkCompletion.state(trace)).toBe("pending");
    expect(await t.roots.engine!.waitIdle(trace, 100)).toBe(true);
    expect(run.deferred).toHaveLength(1);
  });

});
