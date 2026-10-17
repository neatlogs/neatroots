import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { Store } from "../src/store/db.js";
import { evaluateRule } from "../src/checks/rules.js";
import { loadTrace } from "../src/engine/trace.js";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { plainToAny, type OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
const llm = () => span({ traceId: hex(16), name: "chat", kind: "llm" });
function records(sp: OtlpSpan, output: string, input?: string) {
  return decodeLogsJson({ resourceLogs: [{ resource: batch([sp]).resource, scopeLogs: [{ logRecords: [{ traceId: sp.traceId, spanId: sp.spanId, timeUnixNano: "200", eventName: "gen_ai.client.inference.operation.details", body: plainToAny({ "gen_ai.output.messages": [{ role: "assistant", content: output }], ...(input ? { "gen_ai.input.messages": [{ role: "user", content: input }] } : {}) }) }] }] }] });
}
function mockDecisions(slow = false) {
  vi.spyOn(t!.roots.decisions, "isSlow").mockResolvedValue(slow);
  return vi.spyOn(t!.roots.decisions, "decide").mockImplementation(async (e, qs) => ({ answers: Object.fromEntries(qs.map((q) => { const p = q.name.startsWith("r4-") && !e.includes("clean") ? 0.99 : 0.01; return [q.name, { name: q.name, type: q.type, probability: p, distribution: { yes: p, no: 1 - p } }]; })), backend: "mock", model: "mock", latencyMs: 1 }) as never);
}
async function ended(sp: OtlpSpan) {
  await until(() => t!.roots.store.findingsForTrace(sp.traceId).some((f) => f.check_id === "empty-final-answer"));
  expect(await t!.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
}
function held() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

it("reindexes a separate Store replacement from fresh rows without rolling its seq or search back", async () => {
  t = await makeRoots({ noEngine: true }); await until(() => t!.roots.store.getMeta("search_index"));
  const st = t.roots.store, sp = llm();
  const replacement = (text: string) => ({ ...sp, events: [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: text }) }] }] });
  st.ingest([batch([replacement("before")])]); st.setMeta("search_index", "4");
  expect(loadTrace(st, sp.traceId).spans[0].output).toMatchObject([{ content: "before" }]);
  const other = new Store(st.dir);
  const transaction = st.db.transaction.bind(st.db); let injected = false, replacementSeq = 0;
  const modes: string[] = [];
  vi.spyOn(st.db, "transaction").mockImplementation((fn) => {
    const tx = transaction(fn);
    const inject = () => {
      if (injected) return; injected = true;
      other.ingest([batch([replacement("middle")])]); other.ingest([batch([replacement("after")])]);
      replacementSeq = other.getSpanRow(sp.traceId, sp.spanId)!.seq;
    };
    return Object.assign((...args: unknown[]) => { modes.push("deferred"); inject(); return tx(...args); }, {
      immediate: (...args: unknown[]) => { modes.push("immediate"); inject(); return tx.immediate(...args); },
    }) as never;
  });
  try {
    const result = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error })));
    expect(result).toEqual({ n: 1, error: undefined }); expect(replacementSeq).toBe(3);
    const row = st.getSpanRow(sp.traceId, sp.spanId)!;
    expect(row.seq).toBeGreaterThan(replacementSeq);
    expect(row.output_preview).toBe("assistant: after");
    expect(st.searchSpans("after").map((s) => s.span_id)).toEqual([sp.spanId]); expect(st.searchSpans("before")).toEqual([]);
    expect(loadTrace(st, sp.traceId).spans[0].output).toMatchObject([{ content: "after" }]);
    expect(st.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(replacement("after"));
    expect(st.getMeta("search_index")).toBe("5");
    expect(st.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
    expect(modes.length).toBeGreaterThan(0); expect(modes.every((mode) => mode === "immediate")).toBe(true);
  } finally { other.close(); }
});

it("preserves migration rows, marker and receipt when another Store holds the write reservation, then retries", async () => {
  t = await makeRoots({ noEngine: true }); await until(() => t!.roots.store.getMeta("search_index"));
  const st = t.roots.store, sp = llm();
  sp.events = [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: "clean reserved answer" }) }] }];
  st.ingest([batch([sp])]); st.db.exec("UPDATE spans SET output_preview = NULL; UPDATE runs SET output_preview = NULL; UPDATE span_fts SET body = ''"); st.setMeta("search_index", "3");
  st.db.prepare("INSERT INTO check_progress (trace_id, state, updated_ms) VALUES (?, 'checking', 42)").run(sp.traceId);
  const other = new Store(st.dir); other.db.exec("BEGIN IMMEDIATE");
  try {
    const updates = vi.fn();
    const failed = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error }), updates));
    expect((failed.error as Error & { code?: string })?.code).toBe("SQLITE_BUSY"); expect(failed.n).toBe(0);
    expect(st.getMeta("search_index")).toBe("3"); expect(updates).not.toHaveBeenCalled();
    expect(st.getSpanRow(sp.traceId, sp.spanId)?.output_preview).toBeNull(); expect(st.searchSpans("reserved")).toEqual([]);
    expect(st.db.prepare("SELECT state, updated_ms FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking", updated_ms: 42 });
    other.db.exec("ROLLBACK");
    const retried = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error }), updates));
    expect(retried).toEqual({ n: 1, error: undefined }); expect(st.getMeta("search_index")).toBe("5");
    expect(st.getSpanRow(sp.traceId, sp.spanId)?.output_preview).toBe("assistant: clean reserved answer");
    expect(st.searchSpans("reserved").map((s) => s.span_id)).toEqual([sp.spanId]); expect(updates).toHaveBeenCalledTimes(1);
    expect(st.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
    expect(st.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
  } finally { if (other.db.inTransaction) other.db.exec("ROLLBACK"); other.close(); }
});

it("backfills every row across a 300-row boundary despite duplicate sequence values from separate Stores", async () => {
  t = await makeRoots({ noEngine: true }); await until(() => t!.roots.store.getMeta("search_index"));
  const st = t.roots.store, root = llm();
  const message = (text: string) => [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: text }) }] }];
  root.events = message("backfillneedle root"); st.ingest([batch([root])]);
  const other = new Store(st.dir);
  try {
    const children = (prefix: string) => Array.from({ length: 150 }, (_, i) => span({ traceId: root.traceId, spanId: prefix + i.toString(16).padStart(15, "0"), parent: root.spanId, name: "child", kind: "llm", events: message(`backfillneedle ${prefix}${i}`) }));
    st.ingest([batch(children("1"))]); const second = children("2"); other.ingest([batch(second)]);
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM spans").get()).toEqual({ n: 301 });
    expect(st.db.prepare("SELECT COUNT(DISTINCT seq) AS n FROM spans").get()).toEqual({ n: 151 });
    st.db.exec("UPDATE spans SET output_preview = NULL; UPDATE span_fts SET body = ''"); st.setMeta("search_index", "3");
    const result = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error })));
    expect(result).toEqual({ n: 301, error: undefined });
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM spans WHERE output_preview IS NULL").get()).toEqual({ n: 0 });
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM span_fts WHERE span_fts MATCH ?").get("backfillneedle")).toEqual({ n: 301 });
    expect(st.getMeta("search_index")).toBe("5"); expect(st.getOtlpSpan(root.traceId, second[149].spanId)?.span).toEqual(second[149]);
    expect(st.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(root.traceId)).toEqual({ state: "checking" });
  } finally { other.close(); }
});

it("preserves a genuine historical match and halt during ordinary nonreplacement span processing", async () => {
  t = await makeRoots(); mockDecisions(); t.roots.steering.setMode("test-agent", "advisory");
  t.roots.checks.save({ id: "r4-historical", kind: "rule", rule: { type: "match", field: "output", pattern: "secret" }, action: "halt", guidance: "Stop for the secret." }, "user");
  const sp = llm(); sp.endTimeUnixNano = "0"; sp.attributes.push(s("output.value", "secret"));
  t.roots.ingest([batch([sp])]); expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const f = t.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "r4-historical")!;
  const halt = t.roots.store.notesForTrace(sp.traceId).find((n) => n.finding_id === f.id && n.kind === "halt")!;
  expect(f.status).toBe("raised"); expect(halt.status).toBe("pending");
  sp.attributes = sp.attributes.filter((a) => a.key !== "output.value"); sp.attributes.push(s("output.value", "clean"));
  t.roots.ingest([batch([sp])]);
  t.roots.ingest([batch([span({ traceId: sp.traceId, parent: sp.spanId, name: "next step", kind: "tool" })])]);
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getRun(sp.traceId)?.content_revision).toBe(0);
  expect(t.roots.store.getFinding(f.id)?.status).toBe("raised");
  expect(t.roots.store.notesForTrace(sp.traceId).find((n) => n.id === halt.id)?.status).toBe("pending");
});

it("rejects identical rendered text attached to different full evidence span IDs", async () => {
  t = await makeRoots(); const decide = mockDecisions();
  const sp = llm(); t.roots.ingest([batch([sp])]); await ended(sp);
  t.roots.checks.save({ id: "r4-identity", kind: "yes_no", ask: "Is this tool output wrong?", scope: "trace", when: "live", flag_at: 0.5, evidence: { spans: { type: "TOOL" }, last: 1, goal: false, fields: ["output"] } }, "user");
  const hold = held(); const base = decide.getMockImplementation()!; let calls = 0;
  decide.mockImplementation(async (...args) => {
    if (args[1][0].name !== "r4-identity" || ++calls !== 1) return base(...args);
    await hold.promise;
    return { backend: "mock", model: "mock", latencyMs: 1, answers: { "r4-identity": { name: "r4-identity", type: "yes_no", probability: 0.99, distribution: { yes: 0.99, no: 0.01 } } } } as never;
  });
  const tool = (spanId: string) => span({ traceId: sp.traceId, spanId, parent: sp.spanId, name: "lookup", kind: "tool", attrs: [s("output.value", "clean")] });
  t.roots.ingest([batch([tool("abcdef0000000001")])]);
  try {
    await until(() => calls === 1);
    t.roots.ingest([batch([tool("abcdef0000000002")])]);
    await until(() => t!.roots.store.decisionsForTrace(sp.traceId).some((d) => d.check_id === "r4-identity"));
    const texts = decide.mock.calls.filter(([, qs]) => qs[0].name === "r4-identity").map(([e]) => e);
    expect(texts).toHaveLength(2); expect(texts[0]).toBe(texts[1]);
    hold.release(); expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    const ds = t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "r4-identity");
    expect(ds).toHaveLength(1); expect(ds[0].probability).toBe(0.01);
    expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "r4-identity")).toEqual([]);
  } finally { hold.release(); await t.roots.engine!.waitIdle(sp.traceId, 5000); }
});

it.each(["missing", "busy"])("keeps migration incomplete and its batch atomic after %s source failure, then retries", async (failure) => {
  t = await makeRoots({ noEngine: true }); await until(() => t!.roots.store.getMeta("search_index"));
  const spans = [llm(), llm()];
  spans[0].endTimeUnixNano = "0";
  for (const sp of spans) sp.events = [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: "clean upgrade answer" }) }] }];
  t.roots.ingest(spans.map((sp) => batch([sp])));
  const st = t.roots.store;
  st.db.exec("UPDATE spans SET output_preview = NULL; UPDATE runs SET output_preview = NULL; UPDATE span_fts SET body = ''"); st.setMeta("search_index", "3");
  st.db.prepare("INSERT INTO check_progress (trace_id, state, updated_ms) VALUES (?, 'checking', 42)").run(spans[0].traceId);
  const read = st.getOtlpSpan.bind(st); let reads = 0;
  const spy = vi.spyOn(st, "getOtlpSpan").mockImplementation((...args) => {
    if (++reads === 2) { if (failure === "busy") throw new Error("SQLITE_BUSY migration test"); return undefined; }
    return read(...args);
  });
  const updates = vi.fn();
  const failed = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error }), updates));
  expect(failed.error).toBeInstanceOf(Error); expect(failed.n).toBe(0);
  expect(st.getMeta("search_index")).toBe("3"); expect(updates).not.toHaveBeenCalled();
  for (const sp of spans) {
    expect(st.getSpanRow(sp.traceId, sp.spanId)?.output_preview).toBeNull();
    expect(st.getRun(sp.traceId)?.content_revision).toBe(0);
  }
  expect(st.db.prepare("SELECT trace_id, state, updated_ms FROM check_progress").all()).toEqual([{ trace_id: spans[0].traceId, state: "checking", updated_ms: 42 }]);
  expect(st.getRun(spans[0].traceId)).toMatchObject({ status: "running", complete: 0, root_ended: 0 });
  spy.mockRestore();
  const retried = await new Promise<{ n: number; error?: Error }>((resolve) => st.reindexSearch((n, error) => resolve({ n, error }), updates));
  expect(retried).toEqual({ n: 2, error: undefined }); expect(st.getMeta("search_index")).toBe("5");
  expect(updates).toHaveBeenCalledTimes(1);
  for (const sp of spans) {
    expect(st.getRun(sp.traceId)?.content_revision).toBeGreaterThan(0);
    expect(st.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
    expect(st.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
  }
  expect(st.getRun(spans[0].traceId)).toMatchObject({ status: "running", complete: 0, root_ended: 0 });
  st.ingest([batch([span({ traceId: spans[0].traceId, name: "neatlogs.trace.complete", kind: "internal" })])]);
  expect(st.getRun(spans[0].traceId)).toMatchObject({ status: "running", complete: 1, root_ended: 0 });
  expect(st.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(spans[0].traceId)).toEqual({ state: "checking" });
});

it("plans from a late first goal only while the run still has its provisional default plan", async () => {
  t = await makeRoots(); const decide = mockDecisions();
  t.roots.checks.save({ id: "r4-planned-question", kind: "yes_no", ask: "Did the agent ignore the refund request?", scope: "trace", when: "end", flag_at: 0.5 }, "db", "planner");
  const sp = llm(); t.roots.ingest([batch([sp])]); await ended(sp);
  const live = (t.roots.engine as unknown as { live: Map<string, { plan?: { id: string } }> }).live;
  expect(live.get(sp.traceId)?.plan?.id).toBe("default");
  t.roots.ingestLogs(records(sp, "clean partial answer"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(live.get(sp.traceId)?.plan?.id).toBe("default");
  vi.spyOn(t.roots.llm, "isAvailable").mockResolvedValue(true);
  const chat = vi.spyOn(t.roots.llm, "chat").mockResolvedValue({ text: "", model: "mock", json: { rationale: "Use the supplied refund goal", checks: [{ id: "r4-planned-question" }] } } as never);
  t.roots.ingestLogs(records(sp, "clean answer", "clean first refund goal"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(chat.mock.calls.filter(([, opts]) => opts?.schema?.name === "plan")).toHaveLength(1);
  const planId = t.roots.store.getRun(sp.traceId)!.plan_id!;
  expect(t.roots.store.getPlan(planId)).toMatchObject({ created_by: "planner", check_ids: expect.arrayContaining(["r4-planned-question"]) });
  expect(decide.mock.calls.filter(([e, qs]) => qs[0].name === "r4-planned-question" && e.includes("clean first refund goal"))).toHaveLength(1);
  t.roots.ingestLogs(records(sp, "clean second answer", "clean updated goal"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getRun(sp.traceId)?.plan_id).toBe(planId);
  expect(chat.mock.calls.filter(([, opts]) => opts?.schema?.name === "plan")).toHaveLength(1);
});

it("withdraws a disproven content-match finding and halt while preserving matches on another span", async () => {
  t = await makeRoots(); mockDecisions();
  t.roots.steering.setMode("test-agent", "advisory");
  t.roots.checks.save({ id: "r4-secret", kind: "rule", rule: { type: "match", field: "output", pattern: "secret" }, action: "halt", guidance: "Remove the secret." }, "user");
  const sp = llm(); t.roots.ingest([batch([sp])]); await ended(sp);
  const other = span({ traceId: sp.traceId, parent: sp.spanId, name: "other", kind: "llm", attrs: [s("output.value", "secret")] });
  t.roots.ingest([batch([other])]); t.roots.ingestLogs(records(sp, "secret"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const finding = t.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "r4-secret")!;
  expect(finding.status).toBe("raised");
  t.roots.store.insertNote({ trace_id: sp.traceId, finding_id: finding.id, kind: "halt", text: "Remove the secret.", status: "pending", checks: null });
  t.roots.ingestLogs(records(sp, "clean"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getFinding(finding.id)).toMatchObject({ status: "raised", evidence_span_ids: [other.spanId] });
  // Correct the remaining match through event-derived replacement content too.
  other.attributes = other.attributes.filter((a) => a.key !== "output.value");
  t.roots.ingest([batch([other])]); t.roots.ingestLogs(records(other, "clean"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getFinding(finding.id)?.status).toBe("resolved");
  expect(t.roots.store.notesForTrace(sp.traceId).filter((n) => n.finding_id === finding.id && n.kind === "halt").every((n) => n.status === "expired")).toBe(true);
  expect((await t.roots.engine!.previewCheck({ id: "preview-match", kind: "rule", rule: { type: "match", field: "output", pattern: "secret" } })).hits).toEqual([]);
});

it.each([false, true])("refreshes every previously judged span at the slow cap (restart=%s) without judging new spans", async (restart) => {
  t = await makeRoots(); mockDecisions(true);
  t.roots.checks.save({ id: "r4-slow", kind: "yes_no", ask: "Are the arguments wrong?", scope: "span", when: "live", flag_at: 0.5, evidence: { spans: { type: "TOOL" }, fields: ["input", "output"] } }, "user");
  const sp = llm(); sp.endTimeUnixNano = "0"; t.roots.ingest([batch([sp])]);
  const tools = Array.from({ length: 5 }, (_, i) => span({ traceId: sp.traceId, parent: sp.spanId, name: `tool${i}`, kind: "tool", attrs: [s("input.value", `arguments${i}`)] }));
  for (const tool of tools) {
    t.roots.ingest([batch([tool])]);
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  }
  expect(t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "r4-slow").map((d) => d.span_id)).toEqual(tools.slice(0, 4).map((s) => s.spanId));
  const marker = span({ traceId: sp.traceId, name: "neatlogs.trace.complete", kind: "internal" });
  t.roots.ingest([batch([marker])]); await ended(sp);
  const stale = t.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "r4-slow")!;
  expect(stale.status).toBe("raised");
  if (restart) {
    const { home, config } = t.roots; t.roots.close();
    const staging = new Roots({ home, config, noEngine: true });
    staging.ingestLogs(records(sp, "clean answer", "clean shared goal")); staging.close();
    const reopened = new Roots({ home, config });
    t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } }; mockDecisions(true);
    await until(() => reopened.engine!.pending(sp.traceId) > 0 || reopened.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "r4-slow").length > 4);
    // Resume has a live-span pass followed by an end pass; wait past their idle gap.
    await until(() => (reopened.engine as unknown as { live: Map<string, { endHandled: boolean }> }).live.get(sp.traceId)?.endHandled);
  } else t.roots.ingestLogs(records(sp, "clean answer", "clean shared goal"));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  const ids = t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "r4-slow").map((d) => d.span_id);
  for (const tool of tools.slice(0, 4)) expect(ids.filter((id) => id === tool.spanId)).toHaveLength(2);
  expect(ids).not.toContain(tools[4].spanId);
  expect(t.roots.store.getFinding(stale.id)?.status).toBe("resolved");
  expect(t.roots.engine!.progress.state(sp.traceId)).toBeUndefined();
  expect(t.roots.engine!.pending(sp.traceId)).toBe(0);
});

it("rejects a later check's old snapshot even when it starts after the content revision advanced", async () => {
  t = await makeRoots(); const decide = mockDecisions();
  const sp = llm(); t.roots.ingest([batch([sp])]); await ended(sp);
  t.roots.ingestLogs(records(sp, "old answer")); expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  for (const id of ["r4-race-a", "r4-race-b"]) t.roots.checks.save({ id, kind: "yes_no", ask: "Is the output wrong?", scope: "trace", when: "live", flag_at: 0.5 }, "user");
  const first = held(), second = held(); let oldSecondStarted = false;
  const base = decide.getMockImplementation()!;
  decide.mockImplementation(async (...args) => {
    if (args[0].includes("old answer")) {
      if (args[1][0].name === "r4-race-a") await first.promise;
      if (args[1][0].name === "r4-race-b") { oldSecondStarted = true; await second.promise; }
    }
    return base(...args);
  });
  const engine = t.roots.engine as unknown as { live: Map<string, { dirty: Set<string> }>; flushDirty(run: unknown): Promise<void> };
  const run = engine.live.get(sp.traceId)!; run.dirty.add("r4-race-a"); run.dirty.add("r4-race-b");
  const oldFlush = engine.flushDirty(run);
  try {
    await until(() => decide.mock.calls.some(([e, q]) => q[0].name === "r4-race-a" && e.includes("old answer")));
    t.roots.ingestLogs(records(sp, "clean answer"));
    await until(() => t!.roots.store.decisionsForTrace(sp.traceId).some((d) => d.check_id === "r4-race-b"));
    first.release(); await until(() => oldSecondStarted); second.release(); await oldFlush;
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    const decisions = t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id.startsWith("r4-race-"));
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.probability === 0.01)).toBe(true);
    expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id.startsWith("r4-race-"))).toEqual([]);
    expect(t.roots.engine!.progress.state(sp.traceId)).toBeUndefined();
  } finally { first.release(); second.release(); await oldFlush; }
});

it.each(["3", "4"])("creates durable recheck work while upgrading v%s derived content, then reconciles through reopened Roots", async (version) => {
  t = await makeRoots({ noEngine: true });
  await until(() => t!.roots.store.getMeta("search_index"));
  const sp = llm();
  if (version === "3") sp.events = [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: "migration answer" }) }] }];
  t.roots.checks.save({ id: "r4-migration", kind: "yes_no", ask: "Is the output wrong?", scope: "trace", when: "end", flag_at: 0.5 }, "user");
  t.roots.ingest([batch([sp])]);
  if (version === "4") t.roots.ingestLogs(records(sp, "migration answer"));
  // Exact derived state of a pre-GenAI-events database; raw telemetry is already lossless.
  if (version === "3") {
    t.roots.store.db.prepare("UPDATE spans SET input_preview = NULL, output_preview = NULL").run();
    t.roots.store.db.prepare("UPDATE runs SET input_preview = NULL, output_preview = NULL").run();
    t.roots.store.db.prepare("UPDATE span_fts SET body = ''").run();
  }
  t.roots.store.db.prepare("UPDATE runs SET content_revision = 0").run();
  t.roots.store.db.prepare("DELETE FROM check_progress").run(); t.roots.store.setMeta("search_index", version);
  const f = t.roots.store.insertFinding({ trace_id: sp.traceId, check_id: "empty-final-answer", check_kind: "rule", title: "Empty final answer", probability: null, status: "raised", evidence_span_ids: [sp.spanId], detail: {}, model: null, triage_score: null, explanation_id: null });
  t.roots.store.insertDecision({ trace_id: sp.traceId, check_id: "r4-migration", span_id: null, probability: 0.99, evidence_hash: null, answer: null, backend: "mock", latency_ms: 1 });
  t.roots.store.reindexSearch();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(t.roots.store.getRun(sp.traceId)?.content_revision).toBeGreaterThan(0);
  expect(t.roots.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
  const { home, config } = t.roots; t.roots.close(); const reopened = new Roots({ home, config });
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } }; mockDecisions();
  await until(() => reopened.store.getFinding(f.id)?.status === "resolved");
  expect(await reopened.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(reopened.engine!.progress.state(sp.traceId)).toBeUndefined();
  expect(reopened.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === "r4-migration")).toHaveLength(2);
  expect(reopened.store.searchSpans("migration").map((s) => s.span_id)).toContain(sp.spanId);
  expect(reopened.store.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
  expect(reopened.store.getMeta("search_index")).toBe("5");
});

it("delivers upgraded evidence after the one-shot startup resume has already finished", async () => {
  t = await makeRoots({ noEngine: true });
  await until(() => t!.roots.store.getMeta("search_index"));
  const sp = llm(); sp.events = [{ name: "gen_ai.choice", timeUnixNano: "100", attributes: [{ key: "message", value: plainToAny({ content: "clean upgrade answer" }) }] }];
  t.roots.ingest([batch([sp])]);
  const f = t.roots.store.insertFinding({ trace_id: sp.traceId, check_id: "empty-final-answer", check_kind: "rule", title: "Empty final answer", probability: null, status: "raised", evidence_span_ids: [sp.spanId], detail: {}, model: null, triage_score: null, explanation_id: null });
  t.roots.store.db.prepare("UPDATE spans SET output_preview = NULL").run(); t.roots.store.setMeta("search_index", "3");
  const { home, config } = t.roots; t.roots.close();
  const reindex = Store.prototype.reindexSearch;
  let finishMigration!: () => void;
  const hold = vi.spyOn(Store.prototype, "reindexSearch").mockImplementation(function (this: Store, done, update) {
    finishMigration = () => reindex.call(this, done, update);
  });
  const reopened = new Roots({ home, config }); hold.mockRestore();
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } }; mockDecisions();
  const startupResume = vi.spyOn(reopened.engine!.progress, "unfinished");
  let committed = false;
  reopened.bus.on("trace", (u) => {
    if (u.traceId === sp.traceId && u.contentUpdated) committed = reopened.store.getRun(sp.traceId)!.content_revision > 0 && reopened.engine!.progress.state(sp.traceId) === "checking";
  });
  await until(() => startupResume.mock.calls.length > 0);
  expect(reopened.store.getFinding(f.id)?.status).toBe("raised");
  expect(reopened.engine!.progress.state(sp.traceId)).toBeUndefined();
  finishMigration();
  await until(() => reopened.store.getSpanRow(sp.traceId, sp.spanId)?.output_preview === "assistant: clean upgrade answer");
  expect(committed).toBe(true);
  expect(await reopened.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(reopened.store.getFinding(f.id)?.status).toBe("resolved");
  expect(reopened.engine!.progress.state(sp.traceId)).toBeUndefined();
  expect(reopened.store.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
});

it("keeps regex failures unknown while reporting a successful zero-match evaluation explicitly", async () => {
  t = await makeRoots({ noEngine: true });
  const sp = llm(); sp.attributes.push(s("output.value", "clean")); t.roots.ingest([batch([sp])]);
  const snap = loadTrace(t.roots.store, sp.traceId);
  const check = { id: "r4-match-state", kind: "rule", rule: { type: "match", field: "output", pattern: "secret" } } as const;
  expect(evaluateRule(check, snap, true, undefined, true)).toBeNull();
  expect(evaluateRule(check, snap, true, undefined, true, { includeClearedMatches: true })).toEqual({ firing: false, evidenceSpanIds: [], params: { count: "0" } });
  expect(evaluateRule({ ...check, rule: { ...check.rule, pattern: "(" } }, snap, true, undefined, true, { includeClearedMatches: true })).toBeNull();
  const slow = { ...check, rule: { ...check.rule, pattern: "(a|aa)+$" } };
  snap.spans[0].output = "a".repeat(40) + "!";
  expect(evaluateRule(slow, snap, true, undefined, true, { includeClearedMatches: true })).toBeNull();
  expect(evaluateRule(slow, snap, true, undefined, true, { includeClearedMatches: true })).toBeNull();
});
