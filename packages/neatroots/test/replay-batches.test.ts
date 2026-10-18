import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { ReplayBatches, repeatCount } from "../src/replay/batches.js";
import { cliRepeatCount } from "../src/cli/replay-batch.js";
import { EXPLORE_TOOLS } from "../src/mcp/explore-tools.js";
import { TOOLS } from "../src/mcp/tools.js";
import { batch, hex, makeRoots, mockLlm, s, span, toolSpan, until, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function setup(engine = false) {
  const llm = engine ? await mockLlm() : undefined;
  if (llm) cleanup.push(llm.close);
  const t = await makeRoots({ serve: true, noEngine: !engine, llmUrl: llm?.url });
  cleanup.push(t.close);
  const trace = hex(16);
  t.roots.ingest([batch([span({ traceId: trace, name: "original", kind: "workflow", attrs: [s("neatlogs.workflow.input", "Task"), s("neatlogs.workflow.output", "Done")] })], "batch-agent")]);
  return { t, trace };
}

async function endpoint(t: TestRoots, handle: (id: string, n: number) => Promise<void> | void) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const b of req) text += b;
    try { await handle(JSON.parse(text).replay_id, ++calls); res.end("ok"); }
    catch { res.writeHead(500); res.end("script failed"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  t.roots.config.rerun["batch-agent"] = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/run` };
  return () => calls;
}

function send(t: TestRoots, id: string | undefined, problem = false, extraId?: string) {
  const trace = hex(16);
  const root = span({ traceId: trace, name: "repeat", kind: "workflow", attrs: [s("neatlogs.workflow.output", "Done")] });
  const spans = [root];
  if (problem) for (let i = 0; i < 2; i++) spans.push(toolSpan(trace, root.spanId, "flag", "{}", "problem"));
  // Fallback correlation intentionally uses wall time; the shared helper's synthetic clock
  // can lag after earlier tests, so timestamp this scripted run when it actually executes.
  for (const [i, item] of spans.entries()) {
    item.startTimeUnixNano = (BigInt(Date.now() + i) * 1_000_000n).toString();
    item.endTimeUnixNano = (BigInt(Date.now() + i + 1) * 1_000_000n).toString();
  }
  if (extraId) root.attributes.push(s("neatroots.replay.id", extraId));
  const b = batch(spans, "batch-agent");
  if (id) b.resource.attributes.push(s("neatroots.replay.id", id));
  t.roots.ingest([b]);
  return trace;
}

describe("whole-agent replay batches", () => {
  it("strictly validates numbers and CLI tokens", () => {
    for (const n of [0, 21, -1, 1.2, NaN, Infinity, "2", null, true]) expect(() => repeatCount(n)).toThrow(/integer/);
    for (const n of ["2.5", "2x", "1e1", "", "-1"]) expect(() => cliRepeatCount(n)).toThrow(/integer/);
    expect(repeatCount(20)).toBe(20);
    expect(cliRepeatCount("10")).toBe(10);
  });

  it("runs a scripted fraction sequentially through the real engine, deduplicates each check and finalizes clean runs", async () => {
    const { t, trace } = await setup(true);
    t.roots.checks.save(parseChecks(`id: scripted-problem
kind: rule
title: Scripted problem
rule:
  type: match
  span: { type: tool }
  field: output
  pattern: problem
`).checks[0], "user");
    const duplicate = (id: string) => t.roots.store.insertFinding({ trace_id: id, check_id: "scripted-problem", check_kind: "rule", title: "Scripted problem",
      probability: 1, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    duplicate(trace);
    let active = 0;
    let peak = 0;
    const calls = await endpoint(t, async (id, n) => {
      peak = Math.max(peak, ++active);
      send(t, id, n % 2 === 1);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 4);
    const result = await done;
    expect(calls()).toBe(4);
    expect(peak).toBe(1);
    expect(result).toMatchObject({ id: b.id, state: "completed", linked: 4, settled: 4, clean: 2, pending: 0, failed: 0 });
    expect(result.findings.find((f) => f.check_id === "scripted-problem")).toEqual({ check_id: "scripted-problem", count: 2, original: true });
    duplicate(result.repeats[0].trace_id!);
    expect(t.roots.replayBatches.get(b.id)!.findings.find((f) => f.check_id === "scripted-problem")?.count).toBe(2);
    expect(t.roots.replays.forRun(trace)).toHaveLength(4);
  }, 30_000);

  it("does not mistake idle before the delayed end pass for settled, then persists the receipt", async () => {
    const { t, trace } = await setup(true);
    await endpoint(t, (id) => { send(t, id); });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 1);
    await until(() => t.roots.replays.forRun(trace)[0]?.state === "succeeded");
    expect(t.roots.replayBatches.get(b.id)).toMatchObject({ settled: 0, clean: 0, pending: 1 });
    await done;
    expect(t.roots.replayBatches.get(b.id)).toMatchObject({ settled: 1, clean: 1 });
    const restarted = new ReplayBatches(t.roots);
    expect(restarted.get(b.id)).toMatchObject({ settled: 1, clean: 1 });
  });

  it("excludes fallback links, ambiguous evidence and two traces claiming the same repeat", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id, n) => {
      if (n === 1) send(t, undefined);
      if (n === 2) send(t, id, false, "rp_other");
      if (n === 3) { send(t, id); send(t, id); }
    });
    const result = await t.roots.replayBatches.start(trace, 3).done;
    expect(result).toMatchObject({ unlinked: 3, linked: 0, settled: 0, clean: 0 });
  }, 20_000);

  it("cancels remaining repeats while active work finishes, with honest state", async () => {
    const { t, trace } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = await endpoint(t, async (id) => { await gate; send(t, id); });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 20);
    await until(() => calls() === 1);
    expect(t.roots.replayBatches.cancel(b.id)).toMatchObject({ state: "cancelling", settled: 0 });
    release();
    expect(await done).toMatchObject({ state: "cancelled", cancelled: 19, pending: 1 });
    expect(calls()).toBe(1);
  });

  it("keeps no-engine checks pending and exposes failed checks instead of clean", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id) => {
      const newTrace = send(t, id);
      const generation = t.roots.checkCompletion.begin(newTrace);
      t.roots.checkCompletion.failed(newTrace, generation);
    });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ failed: 1, settled: 0, clean: 0, linked: 1 });
  });

  it("excludes a real failed check from the frequency denominator", async () => {
    const { t, trace } = await setup(true);
    t.roots.checks.save(parseChecks(`id: failing-check
kind: yes_no
title: A failing check
scope: trace
when: end
ask: Did the agent fail the scripted task?
evidence:
  spans: { type: workflow }
  fields: [output]
flag_at: 0.8
`).checks[0], "user");
    const fail = vi.spyOn(t.roots.decisions, "decide").mockRejectedValue(new Error("scripted decision failure"));
    try {
      await endpoint(t, (id) => { send(t, id); });
      const result = await t.roots.replayBatches.start(trace, 1).done;
      expect(result).toMatchObject({ failed: 1, settled: 0, clean: 0 });
      expect(t.roots.store.findingsForTrace(result.repeats[0].trace_id!).some((f) => f.status === "failed")).toBe(true);
    } finally { fail.mockRestore(); }
  });

  it("counts a real failing child run while reporting its nonzero exit separately", async () => {
    const { t, trace } = await setup(true);
    const script = path.join(t.roots.home, "agent.cjs");
    fs.writeFileSync(script, `fetch(process.env.NEATLOGS_ENDPOINT + '/v1/trace', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({name:'child',project:'batch-agent',output:'failed',status:'ERROR',error:'scripted agent failure',
        attributes:{'neatroots.replay.id':process.env.NEATROOTS_REPLAY_ID}})
    }).then(r => r.text()).then(() => { process.exitCode = 7; });`);
    t.roots.config.rerun["batch-agent"] = { command: `"${process.execPath}" "${script}"` };
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ execution_failed: 1, settled: 1, evaluation_failed: 0, clean: 0 });
    expect(result.findings.find((f) => f.check_id === "run-failed")?.count).toBe(1);
    expect(t.roots.replays.get(result.repeats[0].replay_id!)?.state).toBe("succeeded");
  });

  it("marks unfinished batches interrupted on restart without launching again", async () => {
    const { t, trace } = await setup();
    t.roots.store.db.prepare("INSERT INTO replay_batches VALUES ('rb_interrupted',?,3,'running',?,NULL,NULL)").run(trace, Date.now());
    for (let i = 1; i <= 3; i++) t.roots.store.db.prepare("INSERT INTO replay_batch_members (batch_id,ordinal,replay_id) VALUES ('rb_interrupted',?,NULL)").run(i);
    const restarted = new ReplayBatches(t.roots);
    expect(restarted.get("rb_interrupted")).toMatchObject({ state: "interrupted", pending: 3, clean: 0 });
  });

  it("bounds an unresponsive active replay and never dispatches its successor", async () => {
    const { t, trace } = await setup();
    t.roots.config.rerun["batch-agent"] = { command: "unused" };
    vi.useFakeTimers();
    const start = vi.spyOn(t.roots.replays, "startRun").mockReturnValue({ replay: { id: "rp_stuck" } as never, done: new Promise(() => {}) });
    try {
      const { done } = t.roots.replayBatches.start(trace, 2);
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 11_001);
      expect(await done).toMatchObject({ state: "failed", error: expect.stringContaining("termination is unconfirmed") });
      expect(start).toHaveBeenCalledTimes(1);
    } finally { start.mockRestore(); vi.useRealTimers(); }
  });

  it("validates API and MCP inputs and leaves omitted-times single replay unchanged", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id) => { send(t, id); });
    const post = (body: object) => fetch(`${t.url}/api/runs/${trace}/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const times of [0, 21, 1.5, "2", null]) {
      const r = await post({ times });
      expect(r.status).toBe(400);
      expect(await r.json()).toHaveProperty("error");
    }
    expect((await post({ times: 2, span_id: "abc" })).status).toBe(400);
    const single = await (await post({})).json();
    expect(single).toMatchObject({ kind: "run", state: "running" });
    expect(single).not.toHaveProperty("times");
    await until(() => t.roots.replays.get(single.id)?.state === "succeeded");
    for (const tool of [TOOLS.find((x) => x.name === "rerun")!, EXPLORE_TOOLS.find((x) => x.name === "replay")!]) {
      expect(tool.input.times.safeParse(1.5).success).toBe(false);
      expect(tool.input.times.safeParse(20).success).toBe(true);
    }
    const replay = EXPLORE_TOOLS.find((x) => x.name === "replay")!;
    await expect(replay.run(t.roots, { trace_id: trace, span_id: "x", times: 2 })).rejects.toThrow(/whole-agent/);
    const stub = vi.spyOn(t.roots.replayBatches, "start").mockReturnValue({ batch: { id: "rb_tool" } as never, done: Promise.resolve({ id: "rb_tool" } as never) });
    expect(await replay.run(t.roots, { trace_id: trace, times: 2 })).toMatchObject({ id: "rb_tool" });
    expect(await TOOLS.find((x) => x.name === "rerun")!.run(t.roots, { trace_id: trace, times: 2 })).toMatchObject({ id: "rb_tool" });
    stub.mockRestore();
  });

  it("counts findings on settled error runs and preserves quiet/dismissed occurrences", async () => {
    const { t, trace } = await setup(true);
    await endpoint(t, (id) => {
      const newTrace = hex(16);
      const b = batch([span({ traceId: newTrace, name: "failed agent", kind: "workflow", status: 2, message: "script failed", attrs: [s("neatlogs.workflow.output", "Could not finish")] })], "batch-agent");
      b.resource.attributes.push(s("neatroots.replay.id", id));
      t.roots.ingest([b]);
    });
    const result = await t.roots.replayBatches.start(trace, 2).done;
    expect(result).toMatchObject({ settled: 2, clean: 0, failed: 0, execution_failed: 2, evaluation_failed: 0 });
    expect(result.repeats.every((r) => r.agent_status === "error")).toBe(true);
    expect(result.findings.find((f) => f.check_id === "run-failed")?.count).toBe(2);
    result.repeats.forEach((r, i) => {
      const f = t.roots.store.findingsForTrace(r.trace_id!).find((f) => f.check_id === "run-failed")!;
      t.roots.store.updateFinding(f.id, { status: i ? "quiet" : "dismissed" });
    });
    expect(t.roots.replayBatches.get(result.id)!.findings.find((f) => f.check_id === "run-failed")?.count).toBe(2);
  });

  it("never reuses an old generation's completion after reprocessing or deletion", async () => {
    const { t, trace } = await setup();
    const c = t.roots.checkCompletion;
    const first = c.begin(trace);
    c.ended(trace, first); c.settle(trace, first);
    expect(c.state(trace)).toBe("settled");
    const next = c.begin(trace);
    c.ended(trace, first); c.settle(trace, first);
    expect(c.state(trace)).toBe("pending");
    c.ended(trace, next); c.settle(trace, next);
    expect(c.state(trace)).toBe("settled");
    t.roots.store.deleteRun(trace);
    t.roots.ingest([batch([span({ traceId: trace, name: "reused id", kind: "workflow" })])]);
    c.ended(trace, next); c.settle(trace, next);
    expect(c.state(trace)).toBe("pending");
  });

  it("does not turn a dismissed evaluation error into an observed finding", async () => {
    const { t, trace } = await setup();
    const f = t.roots.store.insertFinding({ trace_id: trace, check_id: "unavailable", check_kind: "question", title: "Unavailable",
      probability: null, status: "failed", evidence_span_ids: [], detail: { error: "model unavailable" }, model: null, triage_score: null, explanation_id: null });
    t.roots.bus.emit("finding", f);
    t.roots.bus.emit("finding", t.roots.store.updateFinding(f.id, { status: "dismissed" })!);
    await endpoint(t, (id) => { send(t, id); });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 1);
    expect(b.findings).toEqual([]);
    t.roots.replayBatches.cancel(b.id);
    await done;
  });

  it("a late span invalidates a running end pass and a fresh recheck can settle", async () => {
    const { t, trace } = await setup(true);
    await until(() => {
      const state = t.roots.checkCompletion.state(trace);
      if (state === "failed") throw new Error(`initial evaluation failed: ${JSON.stringify(t.roots.store.findingsForTrace(trace))}`);
      return state === "settled";
    });
    const engine = t.roots.engine! as unknown as { summarize: (...args: unknown[]) => Promise<void> };
    const summarize = engine.summarize.bind(engine);
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(engine, "summarize").mockImplementationOnce(async (...args) => { entered = true; await gate; await summarize(...args); });
    const task = t.roots.engine!.recheck(trace);
    await until(() => entered);
    t.roots.ingest([batch([toolSpan(trace, t.roots.store.getRun(trace)!.root_span_id!, "late", "{}", "ok")], "batch-agent")]);
    release();
    await task;
    await t.roots.engine!.waitIdle(trace, 5000);
    expect(t.roots.checkCompletion.state(trace)).toBe("pending");
    spy.mockRestore();
    await t.roots.engine!.recheck(trace);
    await until(() => t.roots.checkCompletion.state(trace) === "settled");
    expect(t.roots.checkCompletion.state(trace)).toBe("settled");
  });

  it("stops remaining dispatch when the original is deleted during a repeat", async () => {
    const { t, trace } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = await endpoint(t, async (id) => { await gate; send(t, id); });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 3);
    await until(() => calls() === 1);
    t.roots.store.deleteRun(trace);
    release();
    expect(await done).toMatchObject({ id: b.id, state: "cancelled", cancelled: 0, error: "original run or batch deleted" });
    expect(calls()).toBe(1);
  });

  it("settles the batch promise on shutdown without querying a closed store", async () => {
    const { t, trace } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = await endpoint(t, async () => { await gate; });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 2);
    await until(() => calls() === 1);
    t.roots.close();
    expect(await done).toMatchObject({ id: b.id, state: "interrupted" });
    release();
    await new Promise((r) => setTimeout(r, 600));
    expect(calls()).toBe(1);
    expect(() => t.roots.replayBatches.start(trace, 1)).toThrow(/shutting down/);
  });
  it("does not retain unrelated or oversized replay identifiers or findings", async () => {
    const { t, trace } = await setup();
    send(t, "x".repeat(100_000));
    const f = t.roots.store.insertFinding({ trace_id: trace, check_id: "unrelated", check_kind: "rule", title: "Unrelated",
      probability: 1, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    t.roots.bus.emit("finding", f);
    for (const table of ["replay_evidence", "replay_evidence_conflicts", "replay_observations", "replay_evaluation_failures"])
      expect(t.roots.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it("rejects a conflicting claim that arrived before a batch candidate and bounds candidate storage", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id) => {
      const candidate = hex(16);
      t.roots.ingest([batch([span({ traceId: candidate, name: "earlier", kind: "workflow", attrs: [s("neatroots.replay.id", "foreign".repeat(1000))] })], "batch-agent")]);
      t.roots.ingest([batch([span({ traceId: candidate, name: "later", kind: "workflow", attrs: [s("neatroots.replay.id", id)] })], "batch-agent")]);
      for (let i = 0; i < 8; i++) send(t, id);
    });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ linked: 0, unlinked: 1 });
    expect(t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_evidence").get()).toEqual({ n: 2 });
    expect(t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_evidence WHERE length(replay_id)>15").get()).toEqual({ n: 0 });
    expect(t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_evidence_conflicts").get()).toEqual({ n: 1 });
  });

  it("removes repeat-derived metadata on run deletion and never recertifies a reused trace", async () => {
    const { t, trace } = await setup();
    let produced = "";
    await endpoint(t, (id) => { produced = send(t, id); });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    const id = result.repeats[0].replay_id!;
    t.roots.store.db.prepare("INSERT INTO replay_observations VALUES (?,?)").run(produced, "seen");
    t.roots.store.db.prepare("INSERT INTO replay_evaluation_failures VALUES (?,?)").run("f", produced);
    t.roots.store.deleteRun(produced);
    for (const table of ["replay_evidence", "replay_observations", "replay_evaluation_failures", "check_completion"])
      expect(t.roots.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE trace_id=?`).get(produced)).toEqual({ n: 0 });
    t.roots.ingest([batch([span({ traceId: produced, name: "reused", kind: "workflow", attrs: [s("neatroots.replay.id", id)] })], "batch-agent")]);
    expect(t.roots.replayBatches.get(result.id)).toMatchObject({ linked: 0, unlinked: 1 });
    expect(t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_batch_exits").get()).toEqual({ n: 0 });
  });

  it("cascades original-run retention and explicit batch deletion through all batch metadata", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id) => { send(t, id); });
    const first = await t.roots.replayBatches.start(trace, 1).done;
    t.roots.replayBatches.delete(first.id);
    expect(t.roots.replayBatches.get(first.id)).toBeUndefined();
    await t.roots.replayBatches.start(trace, 1).done;
    t.roots.store.db.prepare("UPDATE runs SET ended_ms=1,received_ms=1 WHERE trace_id=?").run(trace);
    expect(t.roots.store.sweep(1, Number.MAX_SAFE_INTEGER)).toBe(1);
    for (const table of ["replay_batches", "replay_batch_members", "replay_batch_exits", "replay_evidence", "replay_evidence_conflicts", "replay_batch_original", "replay_observations", "replay_evaluation_failures"])
      expect(t.roots.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it("deletes an active batch without later exit callbacks recreating metadata", async () => {
    const { t, trace } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = await endpoint(t, async (id) => { await gate; send(t, id); });
    const { batch: b, done } = t.roots.replayBatches.start(trace, 3);
    await until(() => calls() === 1);
    t.roots.replayBatches.delete(b.id);
    release();
    expect(await done).toMatchObject({ state: "cancelled", findings: [], trace_id: "" });
    expect(calls()).toBe(1);
    for (const table of ["replay_batch_members", "replay_batch_exits", "replay_evidence"])
      expect(t.roots.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it("does not lose a conflicting claim replaced within the same ingestion", async () => {
    const { t, trace } = await setup();
    await endpoint(t, (id) => {
      const first = span({ traceId: hex(16), name: "first", kind: "workflow", attrs: [s("neatroots.replay.id", "foreign")] });
      const second = { ...first, attributes: [s("neatlogs.span.kind", "workflow"), s("neatroots.replay.id", id)] };
      const oldBatch = batch([first], "batch-agent");
      const newBatch = batch([second], "batch-agent");
      oldBatch.resource.attributes.push(s("neatroots.replay.id", "foreign"));
      newBatch.resource.attributes.push(s("neatroots.replay.id", id));
      t.roots.ingest([oldBatch, newBatch]);
    });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ linked: 0, unlinked: 1 });
  });

  it.each(["span", "later resource"])("prefers unique %s evidence over an unrelated fallback and fixes ordinary navigation", async (mode) => {
    const { t, trace } = await setup(true);
    let unrelated = "";
    let actual = "";
    await endpoint(t, (id) => {
      unrelated = send(t, undefined);
      if (mode === "span") actual = send(t, undefined, false, id);
      else {
        actual = send(t, undefined);
        const followup = batch([toolSpan(actual, t.roots.store.getRun(actual)!.root_span_id!, "later", "{}", "Done")], "batch-agent");
        followup.resource.attributes.push(s("neatroots.replay.id", id));
        t.roots.ingest([followup]);
      }
    });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ linked: 1, unlinked: 0 });
    expect(result.repeats[0].trace_id).toBe(actual);
    expect(t.roots.replays.get(result.repeats[0].replay_id!)!.new_trace_id).toBe(actual);
    expect(t.roots.replays.originOf(unrelated)).toBeUndefined();
  }, 20_000);

  it("counts an execution failure without explicit evidence as unlinked too", async () => {
    const { t, trace } = await setup();
    await endpoint(t, () => { send(t, undefined); throw new Error("script failed"); });
    const result = await t.roots.replayBatches.start(trace, 1).done;
    expect(result).toMatchObject({ execution_failed: 1, unlinked: 1, linked: 0, evaluation_failed: 0 });
  });

});
