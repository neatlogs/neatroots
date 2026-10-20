import { afterEach, expect, it, vi } from "vitest";
import { CORRELATION_LIMITS } from "../src/replay/correlation.js";
import { Replays } from "../src/replay/replay.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots;
const pending: Promise<unknown>[] = [];
const limits = { ...CORRELATION_LIMITS };
afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  Object.assign(CORRELATION_LIMITS, limits);
  vi.restoreAllMocks();
  await t?.close();
});

function emit(trace = hex(16), id?: string, where: "root" | "resource" | "child" = "root") {
  const b = batch([span({ traceId: trace, parent: where === "child" ? hex(8) : undefined,
    name: "replay", kind: where === "child" ? "tool" : "workflow",
    attrs: id && where !== "resource" ? [s("neatroots.replay.id", id)] : [] })], "p");
  if (id && where === "resource") b.resource.attributes.push(s("neatroots.replay.id", id));
  t.roots.ingest([b]);
  return trace;
}

async function setup(onPoll: (n: number) => void = () => {}) {
  t = await makeRoots({ noEngine: true, serve: true });
  const original = emit();
  t.roots.config.rerun.p = { url: "http://replay.test/" };
  const fetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => url === "http://replay.test/" ? Promise.resolve(new Response("ok")) : fetch(url, init));
  const timeout = globalThis.setTimeout.bind(globalThis);
  let polls = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) =>
    timeout(() => { if (ms === 500) onPoll(++polls); fn(...args); }, ms === 500 ? 0 : ms));
  return { original, polls: () => polls, start: () => {
    const started = t.roots.replays.startRun(original);
    pending.push(started.done);
    return started;
  } };
}

it.each(["root", "resource"] as const)("persists explicit %s attribution and REST read-back", async (where) => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, started.replay.id, where);
  expect(await started.done).toMatchObject({ new_trace_id: trace, attribution: "explicit" });
  expect(await (await fetch(t.url + "/api/replays/" + started.replay.id)).json()).toMatchObject({ attribution: "explicit", new_trace_id: trace });
});

it("keeps lone fallback compatible but explicitly unverified after every poll", async () => {
  const x = await setup();
  const started = x.start();
  const trace = emit();
  const replay = await started.done;
  expect(x.polls()).toBe(20);
  expect(replay).toMatchObject({ state: "succeeded", new_trace_id: trace, attribution: "fallback-unverified" });
  expect(replay.attribution_reason).toMatch(/unverified/);
  expect(t.roots.replays.correlation.select(replay.id).trace).toBeNull(); // verification consumers cannot credit timing
});

it("child-only IDs cannot authorize a run or become an untagged fallback", async () => {
  const x = await setup();
  const started = x.start();
  emit(undefined, started.replay.id, "child");
  expect(await started.done).toMatchObject({ new_trace_id: null, attribution: "unknown" });
});

it("accepts a matching resource arriving after an initially untagged child", async () => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, undefined, "child");
  emit(trace, started.replay.id, "resource");
  expect(await started.done).toMatchObject({ new_trace_id: trace, attribution: "explicit" });
});

it.each(["foreign", "typed", "same-request replacement", "resource replacement"])("keeps %s conflicts sticky", async (mode) => {
  const x = await setup();
  const started = x.start();
  const trace = hex(16);
  const root = span({ traceId: trace, name: "root", kind: "workflow", attrs: [s("neatroots.replay.id", started.replay.id)] });
  const wrong = { ...root, attributes: [mode === "typed" ? { key: "neatroots.replay.id", value: { intValue: "1" } } : s("neatroots.replay.id", "foreign")] };
  expect(t.roots.store.db.prepare("SELECT 1 FROM replay_candidates WHERE trace_id=?").get(trace)).toBeUndefined();
  if (mode === "resource replacement") {
    const first = batch([{ ...root, attributes: [] }], "p");
    first.resource.attributes.push(s("neatroots.replay.id", "foreign"));
    t.roots.ingest([first, batch([root], "p")]);
  } else if (mode === "same-request replacement") t.roots.ingest([batch([wrong, root], "p")]);
  else { t.roots.ingest([batch([wrong], "p")]); t.roots.ingest([batch([root], "p")]); }
  expect(await started.done).toMatchObject({ new_trace_id: null, attribution: "ambiguous" });
});

it.each(["contradiction", "duplicate"])("revokes persisted navigation/output on a late %s", async (mode) => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, started.replay.id);
  expect(await started.done).toMatchObject({ new_trace_id: trace });
  emit(mode === "duplicate" ? undefined : trace, mode === "duplicate" ? started.replay.id : "foreign");
  expect(t.roots.replays.get(started.replay.id)).toMatchObject({ state: "succeeded", new_trace_id: null, output_preview: null, attribution: "ambiguous" });
});

it("does not claim an old trace that receives a new replay ID", async () => {
  const x = await setup();
  const old = emit();
  const started = x.start();
  emit(old, started.replay.id);
  expect(await started.done).toMatchObject({ new_trace_id: null, attribution: "unknown" });
});

it("deletion invalidates attribution permanently for a reused trace ID", async () => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, started.replay.id);
  await started.done;
  const events: unknown[] = [];
  const off = t.roots.bus.on("replay", (event) => events.push(event));
  t.roots.store.deleteRun(trace);
  off();
  expect(events).toContainEqual(expect.objectContaining({ id: started.replay.id, new_trace_id: null,
    previous_trace_id: trace, attribution: "unknown" }));
  expect(await (await fetch(t.url + "/api/replays/" + started.replay.id)).json()).toMatchObject({ new_trace_id: null, attribution: "unknown" });
  emit(trace, started.replay.id);
  expect(t.roots.replays.get(started.replay.id)).toMatchObject({ new_trace_id: null, attribution: "unknown" });
  expect(t.roots.replays.correlation.select(started.replay.id).trace).toBeNull();
});

it("does not reopen a producer window persisted by an interrupted process", async () => {
  const x = await setup();
  const id = "rp_123456789abc";
  t.roots.store.db.prepare(`INSERT INTO replays(id,trace_id,kind,via,overrides,state,created_ms,attribution,attribution_reason)
    VALUES (?,?,'run','http','{}','running',1,'unknown','Waiting')`).run(id, x.original);
  t.roots.replays.correlation.open(id, "p");
  emit(undefined, undefined, "child");
  const reopened = new Replays(t.roots);
  emit(undefined, id);
  expect(reopened.get(id)).toMatchObject({ state: "failed", new_trace_id: null, attribution: "unknown" });
  expect((t.roots.store.db.prepare("SELECT active FROM replay_windows WHERE replay_id=?").get(id) as { active: number }).active).toBe(0);
});

it("retains late-conflict protection after reopening the replay registry", async () => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, started.replay.id);
  await started.done;
  const reopened = new Replays(t.roots);
  emit(trace, "foreign");
  expect(reopened.get(started.replay.id)).toMatchObject({ new_trace_id: null, attribution: "ambiguous" });
});

it("migrates historical navigation as unknown rather than explicit", async () => {
  const x = await setup();
  const db = t.roots.store.db;
  // Reproduce the pre-attribution schema in this isolated database.
  db.exec("DROP TRIGGER replay_window_evicted; DROP TRIGGER replay_correlation_deleted; DROP TABLE replays");
  db.exec(`CREATE TABLE replays(id TEXT PRIMARY KEY,trace_id TEXT,span_id TEXT,kind TEXT,via TEXT,overrides TEXT,
    state TEXT,new_trace_id TEXT,output_preview TEXT,error TEXT,log_tail TEXT,created_ms INTEGER,finished_ms INTEGER)`);
  db.prepare("INSERT INTO replays VALUES (?,?,NULL,'run','http','{}','succeeded',?,'legacy answer',NULL,NULL,1,2)").run("rp_111111111111", x.original, hex(16));
  const reopened = new Replays(t.roots);
  expect(reopened.get("rp_111111111111")).toMatchObject({ attribution: "unknown", attribution_reason: expect.stringMatching(/predates/) });
});

it.each(["per-replay", "global"])("%s evidence overflow never arbitrarily certifies a run", async (mode) => {
  const x = await setup();
  CORRELATION_LIMITS.candidates = mode === "per-replay" ? 2 : limits.candidates;
  CORRELATION_LIMITS.totalCandidates = mode === "global" ? 2 : limits.totalCandidates;
  const started = x.start();
  emit(); emit(); emit(undefined, started.replay.id);
  expect(await started.done).toMatchObject({ new_trace_id: null, attribution: "unknown", attribution_reason: expect.stringMatching(/capacity/) });
  expect((t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_candidates").get() as { n: number }).n).toBeLessThanOrEqual(2);
});

it("attribute overflow cannot hide a contradictory claim beyond the evidence bound", async () => {
  const x = await setup();
  const started = x.start();
  const b = batch([span({ traceId: hex(16), name: "root", kind: "workflow",
    attrs: [s("neatroots.replay.id", started.replay.id), ...Array.from({ length: 512 }, (_, i) => s("extra" + i, "x")), s("neatroots.replay.id", "foreign")] })], "p");
  t.roots.ingest([b]);
  expect(await started.done).toMatchObject({ new_trace_id: null, attribution: "ambiguous" });
});

it("too many overlapping active windows become uncertain rather than certifying a subset", async () => {
  const x = await setup();
  CORRELATION_LIMITS.active = 1;
  const a = x.start(), b = x.start();
  emit(undefined, a.replay.id);
  emit(undefined, b.replay.id);
  for (const result of await Promise.all([a.done, b.done]))
    expect(result).toMatchObject({ new_trace_id: null, attribution: "unknown", attribution_reason: expect.stringMatching(/capacity/) });
});

it("prunes bounded attempt history conservatively without recertifying a reused ID", async () => {
  const x = await setup();
  CORRELATION_LIMITS.attempts = 1;
  const first = x.start();
  const trace = emit(undefined, first.replay.id);
  await first.done;
  const second = x.start();
  emit(undefined, second.replay.id);
  await second.done;
  emit(trace, first.replay.id);
  expect(t.roots.replays.get(first.replay.id)).toMatchObject({ new_trace_id: null, attribution: "unknown" });
  expect((t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM replay_windows").get() as { n: number }).n).toBe(1);
});

it("revokes a completed explicit link when a duplicate falls beyond bounded freshness updates", async () => {
  const x = await setup();
  const started = x.start();
  emit(undefined, started.replay.id);
  expect(await started.done).toMatchObject({ attribution: "explicit" });
  CORRELATION_LIMITS.totalCandidates = 2;
  const events: unknown[] = [];
  const off = t.roots.bus.on("replay", (event) => events.push(event));
  t.roots.ingest([batch([
    span({ traceId: hex(16), name: "unrelated1", kind: "workflow" }),
    span({ traceId: hex(16), name: "unrelated2", kind: "workflow" }),
    span({ traceId: hex(16), name: "duplicate", kind: "workflow", attrs: [s("neatroots.replay.id", started.replay.id)] }),
  ], "p")]);
  off();
  expect(t.roots.replays.get(started.replay.id)).toMatchObject({ new_trace_id: null, output_preview: null,
    attribution: "unknown", attribution_reason: expect.stringMatching(/capacity/) });
  expect(events).toContainEqual(expect.objectContaining({ id: started.replay.id, new_trace_id: null, attribution: "unknown" }));
});

it("preserves an unrelated completed explicit link across a large unrelated export", async () => {
  const x = await setup();
  const started = x.start();
  const trace = emit(undefined, started.replay.id);
  await started.done;
  CORRELATION_LIMITS.totalCandidates = 2;
  t.roots.ingest([batch(Array.from({ length: 3 }, (_, i) =>
    span({ traceId: hex(16), name: "unrelated" + i, kind: "workflow" })), "p")]);
  expect(t.roots.replays.get(started.replay.id)).toMatchObject({ new_trace_id: trace, attribution: "explicit" });
});
