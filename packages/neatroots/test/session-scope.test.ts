import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import type { QuestionCheck } from "../src/checks/types.js";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, until } from "./helpers.js";

// scope: session is judged over the conversation's runs so far, not only the run in hand: a
// constraint the user set in turn one still reaches the question at turn two's end, and the
// finding pins to turn two with evidence from turn two only.

const ASK = "Did the agent drop the constraint the user set in an earlier turn?";
const check = (scope: string) =>
  parseChecks(`
- id: dropped-constraint
  kind: yes_no
  scope: ${scope}
  title: Constraint dropped
  ask: ${ASK}
  flag_at: 0.5
  evidence: { spans: { type: [llm] } }
`).checks[0];

const SESSION = "sess-284";
const sessionAttr = { key: "session.id", value: { stringValue: SESSION } };
const T1_USER = "Plan the launch. Constraint blue-472: never email on Fridays.";
const T2_USER = "Draft the update for Friday.";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** One conversation turn: an LLM exchange, then the run ends. Returns [traceId, rootSpanId]. */
async function turn(tb: Awaited<ReturnType<typeof makeRoots>>, user: string, out: string, sid: string = SESSION): Promise<[string, string]> {
  const t = hex(16);
  const root = hex(8);
  const sa = { key: "session.id", value: { stringValue: sid } };
  tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a planner.", user, out, attrs: [sa] })])]);
  await tb.roots.engine!.waitIdle(t, 10_000);
  tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "planner", kind: "workflow", attrs: [sa] }), markerSpan(t, root)])]);
  await until(() => tb.roots.store.getSummary(t), 20_000);
  await tb.roots.engine!.waitIdle(t, 10_000);
  return [t, root];
}

/** Recorded decision requests (the enum-answer calls) whose evidence shows the given text. */
function decisionRequests(requests: any[], containing: string): any[] {
  return requests.filter((b) => {
    const schema = b.response_format?.json_schema;
    if (!schema?.schema?.properties?.answer?.enum) return false;
    return String(b.messages?.[b.messages.length - 1]?.content ?? "").includes(containing);
  });
}

describe("scope: session", () => {
  it("keeps stored session answers during recovery without building evidence again", async () => {
    const llm = await mockLlm({});
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const engine = tb.roots.engine as any;
    const question = check("session");
    const run = { answered: { traceChecks: new Set([question.id]) }, traceEvidence: new Map() };
    const evidence = vi.spyOn(engine, "sessionEvidence").mockReturnValue({ text: "evidence", spanIds: ["span"], ownSpanIds: ["span"] });
    const decide = vi.spyOn(engine, "decideAndApply").mockResolvedValue(undefined);
    await engine.askSession(run, question, {}, { spans: [] });
    expect(evidence).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("does not let a replaced live run persist a session answer", async () => {
    const llm = await mockLlm({});
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const engine = tb.roots.engine as any;
    const question = check("session");
    const traceId = hex(16);
    const run = { traceId, traceEvidence: new Map() };
    engine.live.set(traceId, run);
    vi.spyOn(engine, "sessionEvidence").mockReturnValue({ text: "evidence", spanIds: ["span"], ownSpanIds: ["span"] });
    const decide = vi.spyOn(engine, "decideAndApply").mockImplementation(async (...args: any[]) => {
      const current = args[7];
      expect(typeof current).toBe("function");
      expect(await current()).toBe(true);
      engine.live.set(traceId, { traceId });
      expect(await current()).toBe(false);
    });
    await engine.askSession(run, question, {}, { traceId, spans: [] });
    expect(decide).toHaveBeenCalledOnce();
    engine.live.delete(traceId);
  });

  it("rejects a session decision when the same live run starts a newer end pass", async () => {
    const llm = await mockLlm({});
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const engine = tb.roots.engine as any;
    const question = check("session");
    const traceId = hex(16);
    const run = { traceId, endPass: 1, traceEvidence: new Map() };
    engine.live.set(traceId, run);
    vi.spyOn(engine, "sessionEvidence").mockReturnValue({ text: "old end pass", spanIds: ["span"], ownSpanIds: ["span"] });
    vi.spyOn(engine, "decideAndApply").mockImplementation(async (...args: any[]) => {
      const current = args[7];
      expect(await current()).toBe(true);
      run.endPass++;
      expect(engine.live.get(traceId)).toBe(run);
      expect(await current()).toBe(false);
    });
    await engine.askSession(run, question, {}, { traceId, spans: [] });
    engine.live.delete(traceId);
  });

  it("hydrates only six matching earlier spans, rather than the entire earlier run", async () => {
    const llm = await mockLlm({});
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const traceId = hex(16);
    const root = hex(8);
    const spans = Array.from({ length: 80 }, (_, i) => llmSpan(traceId, root, { user: `old ${i}`, out: `answer ${i}`, attrs: [sessionAttr] }));
    tb.roots.ingest([batch(spans)]);
    await tb.roots.engine!.waitIdle(traceId, 10_000);
    tb.roots.store.db.prepare("UPDATE runs SET status = 'ok' WHERE trace_id = ?").run(traceId);
    const snap = { traceId: hex(16), run: { ...tb.roots.store.getRun(traceId)!, started_ms: Date.now() + 60_000 }, spans: [] };
    // Invalidate the parser cache populated by ingestion so this measures a cold history load.
    tb.roots.store.db.prepare("UPDATE spans SET seq = seq + 1000 WHERE trace_id = ?").run(traceId);
    const hydrate = vi.spyOn(tb.roots.store, "getOtlpSpan");
    const evidence = (tb.roots.engine as any).sessionEvidence(check("session"), snap);
    expect(hydrate).toHaveBeenCalledTimes(6);
    expect(evidence.spanIds).toHaveLength(6);
    expect(evidence.ownSpanIds).toEqual([]);
    expect(evidence.text).toContain("old 79");
    // A later full load must still return every span after the selective load cached a subset.
    expect(loadTrace(tb.roots.store, traceId).spans).toHaveLength(80);
  });

  it("never reaches the 26th earlier run when the newest 25 have no matching spans", async () => {
    const llm = await mockLlm({});
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const [oldest] = await turn(tb, "outside the window", "old response");
    const row = tb.roots.store.getRun(oldest)!;
    const window = Array.from({ length: 25 }, () => ({ ...row, trace_id: hex(16) }));
    vi.spyOn(tb.roots.store, "listRuns").mockReturnValue([...window, row]);
    const metadata = vi.spyOn(tb.roots.store, "getSpans");
    const evidence = (tb.roots.engine as any).sessionEvidence(check("session"), { traceId: hex(16), run: { ...row, started_ms: 0 }, spans: [] });
    expect(evidence.spanIds).toEqual([]);
    expect(metadata).toHaveBeenCalledTimes(25);
    expect(metadata).not.toHaveBeenCalledWith(oldest, false);
    expect(tb.roots.store.listRuns).toHaveBeenCalledWith(expect.objectContaining({ untilMs: -1 }));
  });

  it("judges turn two over the whole conversation, and pins the finding to turn two", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("session"), "user");

    const [t1] = await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    // Turn one's question saw turn one (a one-run session reads as a trace question).
    expect(tb.roots.store.findingsForTrace(t1).some((f) => f.check_id === "dropped-constraint")).toBe(true);

    // Turn two's question was shown turn one's constraint, and still flagged.
    const t2Asked = decisionRequests(llm.requests, T2_USER);
    expect(t2Asked.length).toBeGreaterThan(0);
    expect(t2Asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("blue-472"))).toBe(true);

    const f2 = tb.roots.store.findingsForTrace(t2).find((f) => f.check_id === "dropped-constraint");
    expect(f2).toBeTruthy();
    // Evidence pins to turn two's spans only, even though the judgement saw turn one.
    const t2SpanIds = new Set(tb.roots.store.getSpans(t2).map((s) => s.span_id));
    expect(f2!.evidence_span_ids.length).toBeGreaterThan(0);
    for (const id of f2!.evidence_span_ids) expect(t2SpanIds.has(id)).toBe(true);
  });

  it("scope: trace on the same conversation never sees turn one", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("trace"), "user");

    await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    const t2Asked = decisionRequests(llm.requests, T2_USER);
    expect(t2Asked.length).toBeGreaterThan(0);
    expect(t2Asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("blue-472"))).toBe(false);
  });

  it("previews the newest run of a session over its history", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);

    await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    const preview = await tb.roots.engine!.previewCheck(check("session") as QuestionCheck);
    expect(preview.checked).toBe(1);
    expect(preview.hits).toHaveLength(1);
    expect(preview.hits[0].trace_id).toBe(t2);
    const t2SpanIds = new Set(tb.roots.store.getSpans(t2).map((s) => s.span_id));
    for (const id of preview.hits[0].evidence_span_ids) expect(t2SpanIds.has(id)).toBe(true);
  });

  it("still shows an earlier turn when its span ids repeat in the current run", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("session"), "user");

    // Span ids are only unique within a trace: both turns' LLM spans share one id here.
    const shared = hex(8);
    const send = async (user: string, out: string) => {
      const t = hex(16);
      const root = hex(8);
      const llmSp = llmSpan(t, root, { system: "You are a planner.", user, out, attrs: [sessionAttr] });
      llmSp.spanId = shared;
      tb.roots.ingest([batch([llmSp])]);
      await tb.roots.engine!.waitIdle(t, 10_000);
      tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "planner", kind: "workflow", attrs: [sessionAttr] }), markerSpan(t, root)])]);
      await until(() => tb.roots.store.getSummary(t), 20_000);
      await tb.roots.engine!.waitIdle(t, 10_000);
      return t;
    };
    await send(T1_USER, "Plan drafted.");
    const t2 = await send(T2_USER, "Emailing it Friday.");

    const asked = decisionRequests(llm.requests, T2_USER);
    expect(asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("blue-472"))).toBe(true);
    const f2 = tb.roots.store.findingsForTrace(t2).find((f) => f.check_id === "dropped-constraint");
    expect(f2!.evidence_span_ids.length).toBeGreaterThan(0);
  });

  it("keeps earlier-turn evidence when the current run has more spans than evidence.last", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    const bounded = check("session") as QuestionCheck;
    bounded.evidence = { ...(bounded.evidence ?? {}), last: 3 };
    tb.roots.checks.save(bounded, "user");

    // Turn one's second exchange carries the marker: the first exchange's messages also land in
    // the question's goal section, so they cannot prove the earlier-turn spans made it.
    const t1 = hex(16);
    const root1 = hex(8);
    tb.roots.ingest([batch([
      llmSpan(t1, root1, { system: "You are a planner.", user: T1_USER, out: "Plan drafted.", attrs: [sessionAttr] }),
      llmSpan(t1, root1, { user: "elaborate", out: "delta-888 noted", attrs: [sessionAttr] }),
    ])]);
    await tb.roots.engine!.waitIdle(t1, 10_000);
    tb.roots.ingest([batch([span({ traceId: t1, spanId: root1, name: "planner", kind: "workflow", attrs: [sessionAttr] }), markerSpan(t1, root1)])]);
    await until(() => tb.roots.store.getSummary(t1), 20_000);
    await tb.roots.engine!.waitIdle(t1, 10_000);

    // Turn two has five llm spans, more than evidence.last: applied to the merged list, that
    // limit would drop turn one's constraint from the question entirely.
    const t2 = hex(16);
    const root2 = hex(8);
    const many = [];
    for (let i = 0; i < 5; i++) many.push(llmSpan(t2, root2, { user: `follow-up ${i}`, out: `answer ${i}`, attrs: [sessionAttr] }));
    tb.roots.ingest([batch(many)]);
    await tb.roots.engine!.waitIdle(t2, 10_000);
    tb.roots.ingest([batch([span({ traceId: t2, spanId: root2, name: "planner", kind: "workflow", attrs: [sessionAttr] }), markerSpan(t2, root2)])]);
    await until(() => tb.roots.store.getSummary(t2), 20_000);
    await tb.roots.engine!.waitIdle(t2, 10_000);

    const asked = decisionRequests(llm.requests, "follow-up");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("delta-888"))).toBe(true);
  });

  it("rechecking an older run does not show it later turns", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("session"), "user");

    const [t1] = await turn(tb, T1_USER, "Plan drafted.");
    await turn(tb, "Anything new? gamma-999 applies now.", "Noted gamma-999.");

    // A changed check is recheck's reason to exist; the new question text also bypasses the
    // decision cache (identical evidence + question is served from memory, no model call).
    const revised = check("session");
    revised.ask = `${ASK} (second pass)`;
    tb.roots.checks.save(revised, "user");

    llm.requests.length = 0;
    await tb.roots.engine!.recheck(t1);
    await tb.roots.engine!.waitIdle(t1, 10_000);

    const asked = decisionRequests(llm.requests, T1_USER);
    expect(asked.length).toBeGreaterThan(0);
    for (const b of asked) expect(String(b.messages[b.messages.length - 1].content).includes("gamma-999")).toBe(false);
  });

  it("previews distinct sessions instead of filling the window with one chatty session", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);

    // The chatty session's turns are the newest: a preview that limits before deduplicating
    // sessions fills the window with them and never reaches the other session.
    const [tB] = await turn(tb, T1_USER, "Plan drafted.", "sess-other");
    await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    const preview = await tb.roots.engine!.previewCheck(check("session") as QuestionCheck, { limit: 2 });
    expect(preview.checked).toBe(2);
    expect(preview.total).toBe(2);
    expect(new Set(preview.hits.map((h) => h.trace_id))).toEqual(new Set([t2, tB]));
  });
});
