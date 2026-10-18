import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { validRunIdleMinutes } from "../src/config.js";
import { checkCoverage } from "../src/server/coverage.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, s, span, tmpHome, toolSpan, type TestRoots } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.useRealTimers(); });
const child = (id: string, parent = hex(8)) => span({ traceId: id, parent, name: "work", kind: "tool" });
async function roots(noEngine = true) {
  const t = await makeRoots({ noEngine, config: c => { c.runIdleMinutes = 1; } });
  cleanup.push(t.close); return t;
}

it("periodic lifecycle interrupts a missing-root run even without check_progress", async () => {
  vi.useFakeTimers(); vi.setSystemTime(500_000);
  const t = await roots(false), id = hex(16);
  t.roots.ingest([batch([child(id)])]);
  await vi.advanceTimersByTimeAsync(500);
  t.roots.store.db.prepare("DELETE FROM check_progress WHERE trace_id=?").run(id);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "interrupted", interrupted: 1, root_ended: 0, complete: 0 });
  expect(t.roots.store.findingsForTrace(id).some(f => f.check_id === "run-failed")).toBe(true);
});

it("uses receipt time, including same-span updates, not old or future exporter timestamps", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const t = await roots(); const id = hex(16), future = hex(16);
  const old = child(id); old.startTimeUnixNano = "1"; old.endTimeUnixNano = "2";
  const ahead = child(future); ahead.startTimeUnixNano = "999999999999999999"; ahead.endTimeUnixNano = "999999999999999999";
  t.roots.ingest([batch([old, ahead])]);
  expect(await t.roots.idle.sweep(1_059_999)).toBe(0);
  now.mockReturnValue(1_050_000); t.roots.ingest([batch([old])]);
  expect(await t.roots.idle.sweep(1_060_000)).toBe(1);
  expect(t.roots.store.getRun(future)).toMatchObject({ status: "interrupted", complete: 0, root_ended: 0 });
  expect(t.roots.store.getRun(id)?.status).toBe("running");
  expect(await t.roots.idle.sweep(1_110_000)).toBe(1);
  expect(await t.roots.idle.sweep(1_200_000)).toBe(0);
  expect(t.roots.store.batchesForTraces([id])[0].spans[0]).toMatchObject({ startTimeUnixNano: "1", endTimeUnixNano: "2" });
});

it("runs existing end checks and summary for a real missing-root run, then releases live state", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const llm = await mockLlm({}); cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url, config: c => { c.runIdleMinutes = 1; } }); cleanup.push(t.close);
  const id = hex(16), parent = hex(8);
  t.roots.ingest([batch([llmSpan(id, parent, { user: "Refund order", out: "Refund succeeded." }), toolSpan(id, parent, "refund", "{}", undefined, "HTTP 500")])]);
  await t.roots.engine!.waitIdle(id, 10_000);
  clock.mockReturnValue(2_060_000);
  expect(await t.roots.idle.sweep()).toBe(1);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "interrupted", interrupted: 1, root_ended: 0, complete: 0 });
  expect(t.roots.store.getRun(id)?.termination_reason).toContain("process state unknown");
  expect(t.roots.store.findingsForTrace(id).some(f => f.check_id === "run-failed" && f.detail.idle_inferred)).toBe(true);
  expect(t.roots.store.getSummary(id)).toBeDefined();
  await t.roots.engine!.waitIdle(id, 10_000);
  expect((await t.roots.engine!.status()).liveRuns).toBe(0);
  expect((await checkCoverage(t.roots, id))?.state).not.toBe("checking");
});

it.each(["root", "marker"])("only actual late %s completion clears idle inference and preserves evidence", async mode => {
  vi.spyOn(Date, "now").mockReturnValue(3_000_000);
  const t = await roots(); const id = hex(16), parent = hex(8), c = child(id, parent);
  t.roots.ingest([batch([c])]); await t.roots.idle.sweep(3_060_000);
  const annotation = t.roots.store.insertAnnotation({ trace_id: id, span_id: null, label: "note", text: "keep", author: "test" });
  t.roots.ingest([batch([child(id, parent)])]);
  expect(t.roots.store.getRun(id)?.status).toBe("interrupted");
  const end = mode === "marker" ? markerSpan(id, parent) : span({ traceId: id, spanId: parent, name: "root", kind: "workflow" });
  t.roots.ingest([batch([end])]);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "ok", interrupted: 0, termination_reason: null });
  expect(t.roots.store.annotationsForTrace(id)).toContainEqual(annotation);
  expect(t.roots.store.batchesForTraces([id]).flatMap(b => b.spans).some(s => s.spanId === c.spanId)).toBe(true);
});

it("never clears an explicit producer interruption", async () => {
  vi.spyOn(Date, "now").mockReturnValue(4_000_000);
  const t = await roots(); const id = hex(16), parent = hex(8);
  t.roots.ingest([batch([child(id, parent)])]); await t.roots.idle.sweep(4_060_000);
  t.roots.ingest([batch([span({ traceId: id, spanId: parent, name: "root", kind: "workflow",
    attrs: [s("neatlogs.trace.interrupted", true), s("neatlogs.trace.termination.reason", "user cancelled")] })])]);
  const explicit = t.roots.store.getRun(id)!;
  expect(explicit.interrupted).toBe(1);
  t.roots.ingest([batch([markerSpan(id, parent)])]);
  expect(t.roots.store.getRun(id)?.interrupted).toBe(1);
  expect(t.roots.store.getRun(id)?.termination_reason).toBe("user cancelled");
});

it("persists receipt clocks across restart and gives legacy rows a fresh, bounded grace period", async () => {
  vi.spyOn(Date, "now").mockReturnValue(5_000_000);
  const home = tmpHome(); cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  let r = new Roots({ home, noEngine: true }); r.config.runIdleMinutes = 1;
  const old = hex(16), legacy = Array.from({ length: 40 }, () => hex(16));
  r.ingest([batch([child(old), ...legacy.map(id => child(id))])]);
  for (const id of legacy) r.store.db.prepare("DELETE FROM run_liveness WHERE trace_id=?").run(id);
  r.close(); r = new Roots({ home, noEngine: true }); r.config.runIdleMinutes = 1; cleanup.push(() => r.close());
  expect(await r.idle.sweep(5_060_000)).toBe(1);
  expect(r.store.getRun(old)?.status).toBe("interrupted");
  expect(r.store.db.prepare("SELECT COUNT(*) n FROM run_liveness").get()).toMatchObject({ n: 33 });
  expect(await r.idle.sweep(5_060_001)).toBe(0);
  expect(await r.idle.sweep(5_120_000)).toBe(16);
  expect(r.store.getRun(legacy[0])?.complete).toBe(0);
});

it("keeps unavailable engine semantics and supports disabling idle inference", async () => {
  vi.spyOn(Date, "now").mockReturnValue(6_000_000);
  const t = await roots(); const id = hex(16); t.roots.ingest([batch([child(id)])]);
  t.roots.config.runIdleMinutes = 0;
  expect(await t.roots.idle.sweep(9_000_000)).toBe(0);
  t.roots.config.runIdleMinutes = 1; await t.roots.idle.sweep(9_000_000);
  expect(await checkCoverage(t.roots, id)).toBeNull();
  expect(t.roots.store.getSummary(id)).toBeUndefined();
});

it("validates settings atomically and persists the idle limit", async () => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  for (const value of [-1, 0.5, 10081, null, "10"]) {
    const res = await fetch(`${t.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_idle_minutes: value, retention_days: 99 }) });
    expect(res.status).toBe(400); expect(t.roots.config.retention.days).toBe(14);
  }
  const res = await fetch(`${t.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run_idle_minutes: 0 }) });
  expect(res.status).toBe(200);
  expect(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8")).toContain("runIdleMinutes: 0");
});

it("reconciles late completion during an in-flight inferred end without parallel end passes", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(7_000_000);
  const t = await roots(false), id = hex(16), parent = hex(8), engine = t.roots.engine!;
  t.roots.store.ingest([batch([child(id, parent)])]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = (engine as any).handleEnd.bind(engine);
  let active = 0, maximum = 0;
  const end = vi.spyOn(engine as any, "handleEnd").mockImplementation(async (...args: any[]) => {
    maximum = Math.max(maximum, ++active);
    try { if (end.mock.calls.length === 1) await blocked; await original(...args); }
    finally { active--; }
  });
  const sweep = t.roots.idle.sweep(7_060_000);
  await vi.waitFor(() => expect(active).toBe(1));
  clock.mockReturnValue(7_061_000);
  const actual = span({ traceId: id, spanId: parent, name: "root", kind: "workflow" });
  t.roots.ingest([batch([actual])]); t.roots.ingest([batch([actual])]);
  await new Promise(resolve => setTimeout(resolve, 450));
  release(); await sweep;
  await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(active).toBe(0));
  expect(maximum).toBe(1);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "ok", interrupted: 0, root_ended: 1 });
  expect(t.roots.store.findingsForTrace(id).filter(f => f.detail.idle_inferred && f.status === "raised")).toEqual([]);
});

it("releases failed idle work but leaves interrupted check progress", async () => {
  vi.spyOn(Date, "now").mockReturnValue(8_000_000);
  const t = await roots(false), id = hex(16);
  t.roots.store.ingest([batch([child(id)])]);
  vi.spyOn(t.roots.engine as any, "handleEnd").mockRejectedValue(new Error("test end failure"));
  await t.roots.idle.sweep(8_060_000);
  expect(t.roots.engine!.progress.state(id)).toBe("interrupted");
  expect((await t.roots.engine!.status()).liveRuns).toBe(0);
  expect(await t.roots.idle.sweep(8_120_000)).toBe(0);
});

it("cleans up startup/periodic timers on shutdown", async () => {
  vi.useFakeTimers(); vi.setSystemTime(9_000_000);
  const t = await roots(); const id = hex(16);
  t.roots.ingest([batch([child(id)])]);
  t.roots.close();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await t.roots.idle.sweep()).toBe(0);
});

it("cancels idle shutdown callbacks and retains durable pending work for restart", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10_000_000);
  const llm = await mockLlm({}); cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url, config: c => { c.runIdleMinutes = 1; } }); cleanup.push(t.close);
  const id = hex(16); t.roots.store.ingest([batch([child(id)])]);
  let entered = false, release!: (result: any) => void;
  const chat = t.roots.llm.chat.bind(t.roots.llm);
  vi.spyOn(t.roots.llm, "chat").mockImplementation((messages, options) => {
    if (options?.schema?.name !== "summary") return chat(messages, options);
    entered = true;
    return new Promise(resolve => { release = resolve; });
  });
  const sweep = t.roots.idle.sweep(10_060_000);
  await vi.waitFor(() => expect(entered).toBe(true));
  t.roots.close();
  release({ text: "late summary", json: { lines: ["late summary"] }, where: "local", model: "test", latencyMs: 0 });
  await sweep;
  const reopened = new Roots({ home: t.roots.home, config: t.roots.config, noEngine: true }); cleanup.push(() => reopened.close());
  expect(reopened.store.getSummary(id)).toBeUndefined();
  expect(reopened.store.liveness.needsEnd(id)).toBe(true);
  expect(reopened.store.db.prepare("SELECT state FROM check_progress WHERE trace_id=?").get(id)).toEqual({ state: "interrupted" });
});

it("late completion after restart resolves only the inferred finding and summary", async () => {
  vi.spyOn(Date, "now").mockReturnValue(11_000_000);
  const t = await roots(false), id = hex(16), parent = hex(8);
  t.roots.store.ingest([batch([child(id, parent)])]);
  await t.roots.idle.sweep(11_060_000);
  const finding = t.roots.store.findingsForTrace(id).find(f => f.detail.idle_inferred)!;
  expect(finding.status).toBe("raised");
  t.roots.close();
  const reopened = new Roots({ home: t.roots.home, config: t.roots.config, noEngine: true }); cleanup.push(() => reopened.close());
  reopened.ingest([batch([span({ traceId: id, spanId: parent, name: "root", kind: "workflow", status: 2 })])]);
  expect(reopened.store.getRun(id)).toMatchObject({ status: "error", interrupted: 0 });
  expect(reopened.store.getFinding(finding.id)?.status).toBe("resolved");
});

it("expires durable stale receipts at startup without requiring a progress row", async () => {
  vi.useFakeTimers(); vi.setSystemTime(12_000_000);
  const t = await roots(), id = hex(16); t.roots.ingest([batch([child(id)])]); t.roots.close();
  vi.setSystemTime(12_061_000);
  const reopened = new Roots({ home: t.roots.home, config: t.roots.config }); cleanup.push(() => reopened.close());
  expect(reopened.engine!.progress.state(id)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1500);
  expect(reopened.store.getRun(id)?.status).toBe("interrupted");
  expect(reopened.store.findingsForTrace(id).some(f => f.detail.idle_inferred)).toBe(true);
});

it("bounds transitions and simultaneous end work across repeated sweeps", async () => {
  vi.spyOn(Date, "now").mockReturnValue(13_000_000);
  const t = await roots(false), ids = Array.from({ length: 20 }, () => hex(16));
  t.roots.store.ingest([batch(ids.map(id => child(id)))]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const end = vi.spyOn(t.roots.engine as any, "handleEnd").mockImplementation(() => blocked);
  const first = t.roots.idle.sweep(13_060_000);
  await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(4));
  expect(t.roots.store.listRuns({ status: "interrupted" })).toHaveLength(16);
  expect(await t.roots.idle.sweep(13_060_001)).toBe(4);
  expect(end).toHaveBeenCalledTimes(4);
  release(); await first;
  await t.roots.idle.sweep(13_060_002);
  expect(end).toHaveBeenCalledTimes(8);
});

it("requires finite idle limits", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0.5, 10081, "10", null]) expect(validRunIdleMinutes(value)).toBe(false);
  for (const value of [0, 1, 10, 10080]) expect(validRunIdleMinutes(value)).toBe(true);
});

it.each(["disabled", "out of scope", "missing"])("respects a %s run-failed rule", async mode => {
  vi.spyOn(Date, "now").mockReturnValue(14_000_000);
  const t = await roots(false), id = hex(16);
  const current = t.roots.checks.get("run-failed")!.check;
  if (mode === "disabled") t.roots.checks.save({ ...current, enabled: false }, "user");
  if (mode === "out of scope") t.roots.checks.save({ ...current, applies_to: { project: "elsewhere" } }, "user");
  if (mode === "missing") {
    const all = t.roots.checks.rules.bind(t.roots.checks);
    vi.spyOn(t.roots.checks, "rules").mockImplementation(() => all().filter(c => c.check.id !== "run-failed"));
  }
  t.roots.store.ingest([batch([child(id)])]);
  await t.roots.idle.sweep(14_060_000);
  expect(t.roots.store.getRun(id)?.status).toBe("interrupted");
  expect(t.roots.store.findingsForTrace(id).filter(f => f.check_id === "run-failed")).toEqual([]);
});

it("uses quieting and normal callbacks, and only reconciles the idle-owned finding", async () => {
  vi.spyOn(Date, "now").mockReturnValue(15_000_000);
  const t = await roots(false), id = hex(16), parent = hex(8);
  for (let i = 0; i < 3; i++) {
    const previous = hex(16); t.roots.store.ingest([batch([child(previous)])]);
    t.roots.store.insertFinding({ trace_id: previous, check_id: "run-failed", check_kind: "rule", title: "old", probability: null,
      status: "dismissed", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  }
  t.roots.store.ingest([batch([child(id, parent)])]);
  const raised = vi.spyOn(t.roots.engine as any, "onFindingRaised");
  await t.roots.idle.sweep(15_060_000);
  const quiet = t.roots.store.findingsForTrace(id).find(f => f.check_id === "run-failed")!;
  expect(quiet).toMatchObject({ status: "quiet", detail: { idle_inferred: true } });
  expect(raised.mock.calls.some(call => (call[1] as any).id === quiet.id)).toBe(false);
  const unrelated = t.roots.store.insertFinding({ trace_id: id, check_id: "separate", check_kind: "rule", title: "keep", probability: null,
    status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  const note = t.roots.store.insertNote({ trace_id: id, finding_id: unrelated.id, kind: "template", text: "keep note", status: "delivered", checks: null });
  t.roots.ingest([batch([span({ traceId: id, spanId: parent, name: "root", kind: "workflow" })])]);
  expect(t.roots.store.getFinding(quiet.id)?.status).toBe("resolved");
  expect(t.roots.store.getFinding(unrelated.id)).toEqual(unrelated);
  expect(t.roots.store.notesForTrace(id).find(n => n.id === note.id)).toEqual(note);
});

it("dispatches normal finding callbacks for an applicable raised idle finding", async () => {
  vi.spyOn(Date, "now").mockReturnValue(16_000_000);
  const t = await roots(false), id = hex(16);
  t.roots.store.ingest([batch([child(id)])]);
  const raised = vi.spyOn(t.roots.engine as any, "onFindingRaised");
  await t.roots.idle.sweep(16_060_000);
  const finding = t.roots.store.findingsForTrace(id).find(f => f.check_id === "run-failed")!;
  expect(finding).toMatchObject({ status: "raised", detail: { idle_inferred: true, source: "library" } });
  expect(raised.mock.calls.filter(call => (call[1] as any).id === finding.id)).toHaveLength(1);
});


it("releases settled idle state after a late child and recovers on a real root", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(17_000_000);
  const t = await roots(false), id = hex(16), parent = hex(8), engine = t.roots.engine!;
  t.roots.ingest([batch([child(id, parent)])]);
  await engine.waitIdle(id, 10_000);
  await t.roots.idle.sweep(17_060_000);
  expect((engine as any).live.has(id)).toBe(false);
  clock.mockReturnValue(17_061_000);
  const late = child(id, parent);
  t.roots.ingest([batch([late])]);
  await engine.waitIdle(id, 10_000);
  await t.roots.idle.sweep(17_120_000);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "interrupted", interrupted: 1 });
  expect((await engine.status()).liveRuns).toBe(0);
  expect((engine as any).live.has(id)).toBe(false);
  expect(t.roots.store.batchesForTraces([id]).flatMap(b => b.spans).some(s => s.spanId === late.spanId)).toBe(true);
  t.roots.ingest([batch([span({ traceId: id, spanId: parent, name: "root", kind: "workflow" })])]);
  await new Promise(resolve => setTimeout(resolve, 450));
  await engine.waitIdle(id, 10_000);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "ok", interrupted: 0, root_ended: 1 });
  expect(t.roots.store.findingsForTrace(id).filter(f => f.detail.idle_inferred && f.status !== "resolved")).toEqual([]);
});

it.each([false, true])("withdraws pending inferred halts on recovery with noEngine=%s", async noEngine => {
  vi.spyOn(Date, "now").mockReturnValue(18_000_000);
  const t = await roots(noEngine), id = hex(16), parent = hex(8);
  t.roots.store.ingest([batch([child(id, parent)])]);
  await t.roots.idle.sweep(18_060_000);
  const owned = t.roots.store.insertFinding({ trace_id: id, check_id: "owned", check_kind: "rule", title: "inferred", probability: null,
    status: "raised", evidence_span_ids: [], detail: { idle_inferred: true }, model: null, triage_score: null, explanation_id: null });
  const unrelated = t.roots.store.insertFinding({ trace_id: id, check_id: "separate", check_kind: "rule", title: "keep", probability: null,
    status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  const pending = t.roots.store.insertNote({ trace_id: id, finding_id: owned.id, kind: "halt", text: "stop", status: "pending", checks: null });
  const delivered = t.roots.store.insertNote({ trace_id: id, finding_id: owned.id, kind: "halt", text: "delivered", status: "delivered", checks: null });
  const other = t.roots.store.insertNote({ trace_id: id, finding_id: unrelated.id, kind: "halt", text: "keep", status: "pending", checks: null });
  t.roots.ingest([batch([span({ traceId: id, spanId: parent, name: "root", kind: "workflow" })])]);
  expect(t.roots.store.getFinding(owned.id)?.status).toBe("resolved");
  expect(t.roots.store.getNote(pending.id)?.status).toBe("expired");
  expect(t.roots.store.getNote(delivered.id)).toEqual(delivered);
  expect(t.roots.store.getNote(other.id)).toEqual(other);
  expect(t.roots.store.getRun(id)).toMatchObject({ status: "ok", interrupted: 0, root_ended: 1 });
});


it.each([true, false])("restores idle answers without replacing populated live state (restart=%s)", async restart => {
  const llm = await mockLlm({}); cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url, config: c => { c.runIdleMinutes = 1; } }); cleanup.push(t.close);
  const id = hex(16), parent = hex(8);
  const checks = [
    { id: "restore-trace", scope: "trace", ask: "Did restoration trace evidence fail?" },
    { id: "restore-span", scope: "span", ask: "Did restoration span evidence fail?" },
    { id: "restore-end", scope: "trace", when: "end", ask: "Did restoration end evidence fail?" },
  ] as const;
  for (const c of checks) t.roots.checks.save({ ...c, kind: "yes_no", title: c.id,
    evidence: { spans: { type: ["llm"] }, fields: ["input", "output"] }, flag_at: 0.8 }, "user");
  t.roots.ingest([batch([llmSpan(id, parent, { user: "Inspect this evidence", out: "Evidence processed." })])]);
  await t.roots.engine!.waitIdle(id, 10_000);
  if (!restart) {
    t.roots.ingest([batch([llmSpan(id, parent, { user: "New evidence", out: "New evidence processed." })])]);
    await t.roots.engine!.waitIdle(id, 10_000);
  }
  const before = t.roots.store.decisionsForTrace(id);
  expect(before.filter(d => d.check_id === "restore-trace")).toHaveLength(restart ? 1 : 2);
  expect(before.filter(d => d.check_id === "restore-span")).toHaveLength(restart ? 1 : 2);
  expect(before.filter(d => d.check_id === "restore-end")).toHaveLength(0);
  expect(t.roots.store.getRun(id)?.status).toBe("running");
  if (restart) t.roots.close();
  const reopened = restart ? new Roots({ home: t.roots.home, config: t.roots.config }) : t.roots;
  if (restart) cleanup.push(() => reopened.close());
  expect(await reopened.llm.isAvailable()).toBe(true);
  const requestStart = llm.requests.length;
  const received = reopened.store.db.prepare("SELECT received_ms FROM run_liveness WHERE trace_id=?").get(id) as { received_ms: number };
  expect(reopened.checks.get("restore-end")).toBeDefined();
  expect(reopened.config.runIdleMinutes).toBe(1);
  expect(await reopened.idle.sweep(received.received_ms + 60_000)).toBe(1);
  expect(reopened.store.getRun(id)?.status).toBe("interrupted");
  await reopened.engine!.waitIdle(id, 10_000);
  const after = reopened.store.decisionsForTrace(id);
  for (const key of ["restore-trace", "restore-span"]) {
    expect(after.filter(d => d.check_id === key)).toEqual(before.filter(d => d.check_id === key));
  }
  const requests = llm.requests.slice(requestStart).map(r => JSON.stringify(r));
  expect(requests.filter(r => r.includes("Did restoration trace evidence fail?") || r.includes("Did restoration span evidence fail?"))).toEqual([]);
  expect(after.filter(d => d.check_id === "restore-end")).toHaveLength(1);
  expect(requests.some(r => r.includes("Did restoration end evidence fail?"))).toBe(true);
  expect(reopened.store.getSummary(id)).toBeDefined();
  expect((reopened.engine as any).live.has(id)).toBe(false);
});
