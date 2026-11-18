import { afterEach, describe, expect, it } from "vitest";
import { checkFromInput } from "../src/server/api.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, s, span, toolSpan, until, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(yesWhen: string[] = []) {
  const llm = await mockLlm({ yesWhen });
  const tb = await makeRoots({ llmUrl: llm.url });
  cleanup.push(async () => {
    await tb.close();
    await llm.close();
  });
  return { llm, tb };
}

function startRun(tb: TestRoots) {
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }], tools: ["lookup_order"] })])]);
  return { t, root };
}

describe("engine", () => {
  it("raises a rule finding mid-run and queues a template note when steering is on", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const { t, root } = startRun(tb);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404: not found")])]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
    expect(f.status).toBe("raised");
    const note = await until(() => tb.roots.store.notesForTrace(t).find((n) => n.kind === "template" && n.finding_id === f.id));
    expect(note.text).toContain("lookup_order 3 times");
    // the hook claims it once; the finding becomes active
    const claimed = tb.roots.steering.claim(t, null)!;
    expect(claimed.status).toBe("delivered");
    expect(tb.roots.steering.claim(t, null)?.id ?? null).not.toBe(claimed.id);
    expect(tb.roots.store.getFinding(f.id)!.status).toBe("active");
  });

  it("does not steer when steering is off, but still records findings", async () => {
    const { tb } = await setup();
    const { t, root } = startRun(tb);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    await until(() => tb.roots.store.findingsForTrace(t).length > 0);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.notesForTrace(t)).toEqual([]);
  });

  it("does not re-raise a dismissed finding during the same run", async () => {
    const { tb } = await setup();
    const { t, root } = startRun(tb);
    const repeated = () => toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404");
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([repeated()])]);
    const finding = await until(() => tb.roots.store.findingsForTrace(t).find((item) => item.check_id === "repeated-tool-call"));
    await tb.roots.engine!.waitIdle(t, 5000);
    tb.roots.store.updateFinding(finding.id, { status: "dismissed" });

    tb.roots.ingest([batch([repeated()])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.findingsForTrace(t).filter((item) => item.check_id === "repeated-tool-call")).toEqual([
      expect.objectContaining({ id: finding.id, status: "dismissed" }),
    ]);
  });

  it("does not raise after a finding is dismissed during asynchronous verification", async () => {
    const llm = await mockLlm({ delayMs: 100, yesWhen: ["carry on as if a tool call had succeeded"] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const { t, root } = startRun(tb);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "continue", out: "Refunded order 4512." })])]);
    const old = tb.roots.store.insertFinding({
      trace_id: t, check_id: "ignored-tool-error", check_kind: "question", title: "Carried on", probability: 0.9,
      status: "resolved", evidence_span_ids: [], detail: {}, model: "mock", triage_score: null, explanation_id: null,
    });
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    await until(() => llm.requests.some((r) => r.response_format?.json_schema?.name === "verification"), 15_000);
    tb.roots.store.updateFinding(old.id, { status: "dismissed" });
    await tb.roots.engine!.waitIdle(t, 15_000);

    expect(tb.roots.store.findingsForTrace(t).filter((item) => item.check_id === "ignored-tool-error")).toEqual([
      expect.objectContaining({ id: old.id, status: "dismissed" }),
    ]);
  });

  it("delivers nothing once steering is turned off, a halt included", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const { t, root } = startRun(tb);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    await until(() => tb.roots.store.notesForTrace(t, "pending").length > 0);
    // user turns steering off while the note is still pending
    tb.roots.steering.setMode("test-agent", "off");
    expect(tb.roots.steering.claim(t, null)).toBeUndefined();
    // off means off (docs/steering.md): no halt is queued or delivered either
    expect(tb.roots.steering.push({ traceId: t, findingId: null, kind: "halt", text: "stop" })).toBeUndefined();
    expect(tb.roots.steering.claim(t, null)).toBeUndefined();
  });

  it("plans, asks questions, triages and summarizes at run end", async () => {
    const { tb, llm } = await setup(["carry on as if a tool call had succeeded"]);
    const { t, root } = startRun(tb);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "continue", out: "Refunded order 4512." })])]);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    const summary = await until(() => tb.roots.store.getSummary(t), 15000);
    expect(summary.text.split("\n")).toHaveLength(3);
    const plan = tb.roots.store.getPlan(tb.roots.store.getRun(t)!.plan_id!)!;
    expect(plan.created_by).toBe("planner");
    expect(plan.check_ids).toContain("ignored-tool-error");
    const f = tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "ignored-tool-error");
    // An LLM judgment is confident here but capped: its own probability isn't calibrated.
    expect(f?.probability).toBeGreaterThan(0.8);
    expect(f?.probability).toBeLessThanOrEqual(0.9);
    expect(f?.triage_score).not.toBeNull();
    const decisions = tb.roots.store.decisionsForTrace(t);
    expect(decisions.some((d) => d.check_id === "unfinished-task" && d.probability < 0.5)).toBe(true);
    expect(llm.requests.some((r) => r.response_format?.json_schema?.name === "plan")).toBe(true);
  });

  it("gate mode waits for checks before the hook's claim", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "gate");
    const { t, root } = startRun(tb);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    const note = await tb.roots.steering.gate(t, 300, null);
    expect(note?.text).toContain("lookup_order");
  });

  it("previews a question over finished runs and explains a run", async () => {
    const { tb } = await setup(["refund without"]);
    const { t, root } = startRun(tb);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" })])]);
    await until(() => tb.roots.store.getSummary(t), 15000);
    const preview = await tb.roots.engine!.previewCheck({ id: "p", kind: "yes_no", scope: "trace", ask: "Did the agent refund without confirming ownership?", flag_at: 0.8 } as never);
    expect(preview.checked).toBe(1);
    expect(preview.hits).toHaveLength(1);
    const exp = await tb.roots.engine!.explainRun(t, { force: true });
    expect(exp?.cause).toContain("order id");
    expect(exp?.grounding).not.toBeNull();
  });

  it("keeps a steering note the run ended too soon to get, as not sent", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const emitted: { status: string; finding_id: string | null }[] = [];
    tb.roots.bus.on("note", (n) => emitted.push(n));
    const { t, root } = startRun(tb);
    // End the run FIRST (fast run), then the repeated-tool-call finding fires late.
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
    expect(f.status).toBe("raised");
    // The guidance is not silently lost: it's kept as a not-sent note, and the app is told.
    const note = await until(() => tb.roots.store.notesForTrace(t).find((n) => n.finding_id === f.id));
    expect(note.status).toBe("expired");
    expect(note.kind).toBe("template");
    expect(emitted.some((n) => n.finding_id === f.id && n.status === "expired")).toBe(true);
    expect(tb.roots.store.notesForTrace(t).some((n) => n.status === "delivered")).toBe(false);
  });

  it("keeps the note when a whole fast run arrives in one batch", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const t = hex(16);
    const root = hex(8);
    const call = () => toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404: not found");
    tb.roots.ingest([
      batch([
        llmSpan(t, root, { system: "You are a refund agent.", user: "Refund order 4512", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }], tools: ["lookup_order"] }),
        call(),
        call(),
        call(),
        span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }),
        markerSpan(t, root),
      ]),
    ]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
    const note = await until(() => tb.roots.store.notesForTrace(t).find((n) => n.finding_id === f.id));
    expect(note.status).toBe("expired"); // was: no note at all (push() refused a run that wasn't running)
    await tb.roots.engine!.waitIdle(t, 5000);
    // tool-error-streak is about the same calls; a live run would get one note, so this keeps one
    expect(tb.roots.store.findingsForTrace(t).some((x) => x.check_id === "tool-error-streak")).toBe(true);
    expect(tb.roots.store.notesForTrace(t)).toHaveLength(1);
  });

  it("doesn't show end-of-run checks or Re-run checks as missed steering", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const { t, root } = startRun(tb);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404: not found")])]);
    await until(() => tb.roots.store.notesForTrace(t, "pending").length > 0); // steered while running
    // ends with an empty final answer: the run_end rule fires in the end-of-run pass
    tb.roots.ingest([batch([llmSpan(t, root, { user: "continue", out: "" }), span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    const endOnly = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "empty-final-answer"));
    await tb.roots.engine!.waitIdle(t, 5000);
    const noteFor = (id: string) => tb.roots.store.notesForTrace(t).filter((n) => n.finding_id === id);
    expect(noteFor(endOnly.id)).toEqual([]); // could never have been steered
    // Re-run checks on the finished run: nothing new shows as not sent
    const before = tb.roots.store.notesForTrace(t).length;
    await tb.roots.engine!.recheck(t);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.notesForTrace(t).length).toBe(before);
  });

  it("stays silent when steering is off and the run ended (no missed-note record)", async () => {
    const { tb } = await setup();
    // steering NOT enabled for this project
    const { t, root } = startRun(tb);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow" }), markerSpan(t, root)])]);
    for (let i = 0; i < 3; i++) tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', undefined, "404")])]);
    await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "repeated-tool-call"));
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.notesForTrace(t)).toEqual([]);
  });

  it("deduplicates a finding when question evaluations finish together", async () => {
    const { tb } = await setup(["did it fail"]);
    const { t } = startRun(tb);
    const engine = tb.roots.engine as any;
    const run = engine.live.get(t);
    const check = { id: "concurrent-check", kind: "yes_no", scope: "trace", title: "Concurrent check", ask: "Did it fail?", flag_at: 0.8 };
    const snap = { spans: [], run: tb.roots.store.getRun(t) };
    engine.decisions.decide = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        answers: { [check.id]: { name: check.id, type: "yes_no", probability: 0.9, distribution: { yes: 0.9, no: 0.1 }, choice: "yes" } },
        backend: "test",
        model: "test",
        latencyMs: 20,
      };
    };
    engine.llm.isAvailable = async () => false;

    await Promise.all([engine.decideAndApply(run, check, {}, "It failed.", [], snap, null), engine.decideAndApply(run, check, {}, "It failed.", [], snap, null)]);

    expect(tb.roots.store.findingsForTrace(t).filter((f) => f.check_id === check.id)).toHaveLength(1);
  });
});

describe("a run that ended on a span whose parent had not arrived yet (#157)", () => {
  /** `until` takes a sync predicate; these assertions need to await the engine's status. */
  async function untilAsync(fn: () => Promise<boolean>, timeoutMs = 8000, stepMs = 100): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("untilAsync: timed out");
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  it("is live again when the caller's own span arrives, and end work runs on the full trace", async () => {
    const { tb } = await setup();
    const t = hex(16);
    const callerId = hex(8);
    const live = async () => (await tb.roots.engine!.status()).liveRuns;
    // The callee exports first because it ended first, and its parent is not here yet, so the run
    // ends on it. End-of-run work (rules at the end, questions, the summary) sees only this slice.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    await untilAsync(async () => (await live()) === 0);

    // The caller's own span arrives still open: it is the real root, so the run is not over and
    // there is more to come.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow", attrs: [s("neatlogs.workflow.input", '{"q":"hello"}')] });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    await untilAsync(async () => (await live()) === 1);

    // It ends on the caller's own span, and the end pass runs again with both spans in the trace.
    tb.roots.ingest([batch([caller])]);
    await untilAsync(async () => (await live()) === 0);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: callerId, root_name: "caller-agent", root_ended: 1 });
    expect(tb.roots.store.getSpans(t, false)).toHaveLength(2);
  });

  it("does not release a reopened run's live state when the first end's timer fires", async () => {
    const { tb } = await setup();
    const t = hex(16);
    const callerId = hex(8);
    const live = async () => (await tb.roots.engine!.status()).liveRuns;
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    await untilAsync(async () => (await live()) === 0);

    // The caller's own span arrives open: the run is reopened, and the live state (plan, decided
    // spans, budgets) has to survive. The first end scheduled a release for 60 s later; firing it
    // must not take a run that is running again.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    await untilAsync(async () => (await live()) === 1);

    const engine = tb.roots.engine as unknown as { live: Map<string, unknown>; releaseLive: (r: unknown) => void };
    const entry = engine.live.get(t);
    expect(entry).toBeDefined();
    engine.releaseLive(entry);
    expect(engine.live.get(t)).toBe(entry);

    // Once the caller's own span ends, the release the second end schedules takes it.
    tb.roots.ingest([batch([caller])]);
    await untilAsync(async () => {
      engine.releaseLive(entry);
      return engine.live.get(t) === undefined;
    });
  });

  it("stays running when one update carries the callee's end and the caller's open span", async () => {
    const { tb } = await setup();
    const t = hex(16);
    const callerId = hex(8);
    const live = async () => (await tb.roots.engine!.status()).liveRuns;
    const callee = span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 });
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    // Both arrive together, in the order a batch exporter sends them: the callee (ended) first.
    // The store ends on the callee, then reopens on the caller; the engine must follow the run's
    // final state rather than the update's flags, so no end pass is scheduled for an open run.
    tb.roots.ingest([batch([callee, { ...caller, endTimeUnixNano: "0" }])]);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "running", root_span_id: callerId, root_ended: 0 });
    await untilAsync(async () => (await live()) === 1);

    // It ends when the caller's own span ends.
    tb.roots.ingest([batch([caller])]);
    await untilAsync(async () => (await live()) === 0);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: callerId, root_name: "caller-agent", root_ended: 1 });
  });

  it("steers a rule the caller's span raises, even though the run had ended on the callee", async () => {
    const { tb } = await setup();
    tb.roots.steering.setMode("test-agent", "advisory");
    const rule = checkFromInput(`
id: caller-boom
kind: rule
title: The caller hit a problem
rule:
  type: match
  field: input
  pattern: BOOM
  span:
    type: workflow
`).check;
    if (!rule) throw new Error("rule did not parse");
    tb.roots.checks.save(rule, "user");
    const t = hex(16);
    const callerId = hex(8);
    // The callee ends first and the run ends on it; its end pass runs.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    await new Promise((r) => setTimeout(r, 600)); // let the first end's 400 ms pass run
    // The caller arrives open with a span that trips the rule. The rule has to see the reopened
    // run, or the note is kept as never-sent instead of steering the active agent.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow", attrs: [s("neatlogs.workflow.input", "BOOM happened")] });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "caller-boom"));
    expect(f.status).toBe("raised");
    const note = tb.roots.steering.claim(t, null);
    expect(note?.text).toContain("The caller hit a problem");
  });

  it("stops an end pass the hand-back invalidated before it stores a summary", async () => {
    const { tb } = await setup();
    // An end-only question, so the end pass parks on the judge and can be caught mid-flight.
    const q = checkFromInput(`
id: end-question
kind: yes_no
scope: trace
when: end
title: Did the run finish cleanly?
ask: Did the agent finish its work without leaving anything half-done?
flag_at: 0.9
evidence: { spans: { type: [workflow] } }
`).check;
    if (!q) throw new Error("question did not parse");
    tb.roots.checks.save(q, "user");
    const engine = tb.roots.engine as unknown as { decisions: { decide: (...a: unknown[]) => Promise<unknown> } };
    const real = engine.decisions.decide.bind(engine.decisions);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    engine.decisions.decide = async (...args: unknown[]) => {
      await gate;
      return real(...args);
    };
    // Availability is a network probe and can flicker under load; this test is about the staleness
    // guard, so pin it and exercise the summarize path itself.
    (tb.roots.llm as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => true;
    const t = hex(16);
    const callerId = hex(8);
    // The callee ends first: the run ends on it and its end pass starts, parking on the judge.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    await new Promise((r) => setTimeout(r, 800)); // the 400 ms end pass has started and parked
    expect(tb.roots.store.getSummary(t)).toBeUndefined(); // parked: it cannot have finished

    // The caller's own span arrives open: the run is running again and that pass is for a stale root.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    release();
    await new Promise((r) => setTimeout(r, 800)); // the stale pass resumes and finishes

    // It must not have summarized the callee's slice of the trace, or the real end pass below
    // would skip the summary entirely (summarize leaves an existing one alone).
    expect(tb.roots.store.getSummary(t)).toBeUndefined();
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "running", root_ended: 0 });

    // The real end pass, on the full trace, still stores one.
    tb.roots.ingest([batch([caller])]);
    await until(() => tb.roots.store.getSummary(t), 10_000);
  });

  it("stops a pass the hand-back invalidated while the summary model was answering", async () => {
    const { tb } = await setup();
    const llm = tb.roots.llm as unknown as { chat: (...a: unknown[]) => Promise<unknown>; isAvailable: () => Promise<boolean> };
    llm.isAvailable = async () => true; // a network probe that can flicker; the staleness guard is under test
    const realChat = llm.chat.bind(tb.roots.llm);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    llm.chat = async (...args: unknown[]) => {
      if ((args[1] as { schema?: { name?: string } } | undefined)?.schema?.name === "summary") {
        parked = true;
        await gate;
      }
      return realChat(...args);
    };
    const t = hex(16);
    const callerId = hex(8);
    // The callee ends first: the run ends on it and its end pass reaches the summary call.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    await until(() => parked, 10_000); // the pass is inside the summary chat now

    // The caller's own span arrives open: the run is running again and that pass is for a stale root.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    release();
    await new Promise((r) => setTimeout(r, 800)); // the stale pass resumes and finishes

    // The answer that came back describes the callee's slice. Storing it would be the summary the
    // real pass then skips, and with summariesPerRun at 1 the budget it took would be gone too.
    expect(tb.roots.store.getSummary(t)).toBeUndefined();
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "running", root_ended: 0 });

    // The real end pass, on the full trace, still stores one.
    tb.roots.ingest([batch([caller])]);
    await until(() => tb.roots.store.getSummary(t), 10_000);
  });

  it("leaves deferred work the hand-back invalidated to the next end pass", async () => {
    const llm = await mockLlm();
    // No investigations budget, so every triaged finding queues its investigation instead of
    // running it on the spot.
    const tb = await makeRoots({ llmUrl: llm.url, config: (c) => (c.budgets.investigationsPerRun = 0) });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    // Two rules on the callee, so the pass has two investigations queued behind it.
    for (const id of ["callee-boom-a", "callee-boom-b"]) {
      const rule = checkFromInput(`
id: ${id}
kind: rule
title: The callee hit a problem
rule:
  type: match
  field: input
  pattern: BOOM
  span:
    type: workflow
`).check;
      if (!rule) throw new Error("rule did not parse");
      tb.roots.checks.save(rule, "user");
    }
    const engine = tb.roots.engine as unknown as { decisions: { decide: (...a: unknown[]) => Promise<unknown> } };
    const real = engine.decisions.decide.bind(engine.decisions);
    engine.decisions.decide = async (...args: unknown[]) => {
      const qs = args[1] as { name?: string }[] | undefined;
      // Worth a closer look, so each finding wants an investigation.
      if (qs?.some((q) => q.name === "triage")) return { answers: { triage: { score: 3 } }, backend: "test", model: "test" };
      return real(...args);
    };
    const client = tb.roots.llm as unknown as { chat: (...a: unknown[]) => Promise<unknown>; isAvailable: () => Promise<boolean> };
    client.isAvailable = async () => true;
    const realChat = client.chat.bind(tb.roots.llm);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const investigations: string[] = [];
    client.chat = async (...args: unknown[]) => {
      if ((args[1] as { schema?: { name?: string } } | undefined)?.schema?.name === "investigation") {
        const user = (args[0] as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
        if (user.includes("The callee hit a problem")) {
          investigations.push(user);
          if (investigations.length === 1) {
            parked = true;
            await gate;
          }
        }
      }
      return realChat(...args);
    };
    const t = hex(16);
    const callerId = hex(8);
    // The callee ends first with the problem on it: both findings are triaged and both
    // investigations are queued for the end pass.
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300, attrs: [s("neatlogs.workflow.input", "BOOM happened")] })])]);
    await until(() => tb.roots.store.getRun(t)?.root_ended === 1);
    const mine = () => tb.roots.store.findingsForTrace(t).filter((f) => f.title === "The callee hit a problem");
    await until(() => mine().length === 2 && mine().every((f) => f.triage_score !== null), 10_000);
    await until(() => parked, 10_000); // the pass is inside the first queued investigation now

    // The caller's own span arrives open: the run is running again and that pass is for a stale root.
    const caller = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    release();
    await new Promise((r) => setTimeout(r, 800)); // the stale pass resumes and finishes

    // The investigation already in flight finishes; the one still queued waits for the real pass
    // rather than reading the callee's slice of the trace.
    expect(investigations).toHaveLength(1);

    // The real end pass, on the full trace, runs the queued work.
    tb.roots.ingest([batch([caller])]);
    await until(() => investigations.length === 2, 10_000);
  });
});

describe("planning", () => {
  it("makes one plan per workflow when runs start together, and always includes baseline questions", async () => {
    const llm = await mockLlm({ delayMs: 150 });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const runs = [startRun(tb), startRun(tb), startRun(tb)];
    await until(() => runs.every((r) => tb.roots.store.getRun(r.t)?.plan_id), 15000);
    const plans = tb.roots.store.listPlans();
    expect(plans.filter((p) => p.workflow === "test-agent")).toHaveLength(1);
    expect(new Set(runs.map((r) => tb.roots.store.getRun(r.t)!.plan_id)).size).toBe(1);
    const asked = tb.roots.engine!.questionsFor({ project: "test-agent", workflow: "test-agent", plan: plans[0] }).map((q) => q.check.id);
    expect(asked).toContain("ignored-tool-error");
    expect(asked).toContain("followed-injected-instructions");
  });
});
