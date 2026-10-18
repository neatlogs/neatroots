import { afterEach, expect, it, vi } from "vitest";
import { CORRELATION_LIMITS, ReplayCorrelation } from "../src/replay/correlation.js";
import { Store } from "../src/store/db.js";
import { Replays } from "../src/replay/replay.js";
import { batch, hex, llmSpan, makeRoots, s, span, type TestRoots } from "./helpers.js";
let t: TestRoots;
const readers: Store[] = [];
const limits = { ...CORRELATION_LIMITS };
afterEach(async () => { Object.assign(CORRELATION_LIMITS, limits); vi.restoreAllMocks(); for (const reader of readers.splice(0)) reader.close(); await t?.close(); });
async function setup() {
  t = await makeRoots({ noEngine: true, serve: true });
  const original = hex(16), root = span({ traceId: original, name: "source", kind: "workflow" });
  const llm = llmSpan(original, root.spanId, { user: "Question", out: "old" });
  t.roots.ingest([batch([root, llm], "p")]);
  vi.spyOn(t.roots.llm, "chat").mockResolvedValue({ text: "independently owned answer", model: "mock", latencyMs: 0 });
  return { original, llm, replay: () => t.roots.replays.replayLlm(original, llm.spanId) };
}
function request(trace: string, id: string, output = "new") {
  return batch([span({ traceId: trace, name: "result", kind: "workflow", attrs: [s("neatroots.replay.id", id), s("neatlogs.workflow.output", output)] })], "p");
}
function post(b: ReturnType<typeof batch>) {
  return fetch(t.url + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ resource: b.resource, scopeSpans: [{ scope: b.scope, spans: b.spans }] }] }) });
}
it("rolls canonical ingest and mid-observe evidence back before collector failure; retries atomically", async () => {
  await setup();
  const id = "rp_123456789abc", trace = hex(16);
  t.roots.replays.correlation.open(id, "p");
  const events: string[] = [], committed: { transaction: boolean; visible: boolean }[] = [];
  const reader = new Store(t.roots.store.dir); readers.push(reader);
  t.roots.bus.on("trace", () => {
    committed.push({ transaction: t.roots.store.db.inTransaction, visible: !!reader.getRun(trace) });
    events.push("trace");
  });
  t.roots.bus.on("replay", () => events.push("replay"));
  t.roots.store.db.exec(`CREATE TRIGGER fail_claim BEFORE INSERT ON replay_trace_claims BEGIN SELECT RAISE(ABORT,'mid-observe'); END`);
  expect((await post(request(trace, id))).status).toBe(500);
  expect(t.roots.store.getRun(trace)).toBeUndefined();
  expect(t.roots.store.db.prepare("SELECT * FROM replay_candidates WHERE trace_id=?").all(trace)).toEqual([]);
  expect(events).toEqual([]);
  t.roots.store.db.exec("DROP TRIGGER fail_claim");
  expect((await post(request(trace, id))).status).toBe(200);
  expect(t.roots.replays.correlation.select(id)).toMatchObject({ trace, attribution: "explicit" });
  expect(events).toEqual(["trace"]);
  expect(committed).toEqual([{ transaction: false, visible: true }]);
});
it("rolls association and replacement evidence back without reclaiming the previous committed blob", async () => {
  const x = await setup(), r = await x.replay(), trace = r.new_trace_id!;
  const b = request(trace, r.id, "A".repeat(100_000));
  t.roots.ingest([b]);
  const before = t.roots.store.getOtlpSpan(trace, b.spans[0].spanId);
  const events: unknown[] = [];
  t.roots.bus.on("replay", e => events.push(e));
  t.roots.bus.on("trace", e => events.push(e));
  t.roots.store.db.exec(`CREATE TRIGGER fail_association BEFORE UPDATE ON replays WHEN NEW.attribution='ambiguous'
    BEGIN SELECT RAISE(ABORT,'association-failure'); END`);
  const replacement = { ...b, spans: [{ ...b.spans[0], attributes: [s("neatroots.replay.id", "foreign"), s("neatlogs.workflow.output", "B".repeat(100_000))] }] };
  expect(() => t.roots.ingest([replacement])).toThrow(/association-failure/);
  expect(events).toEqual([]);
  expect(t.roots.store.getOtlpSpan(trace, b.spans[0].spanId)).toEqual(before);
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: trace, attribution: "explicit" });
  t.roots.store.db.exec("DROP TRIGGER fail_association");
  t.roots.ingest([replacement]);
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, attribution: "ambiguous" });
  expect(events).toHaveLength(2);
});
it("postcommit observer exceptions do not change collector success or skip other observers/updates", async () => {
  await setup();
  const seen: string[] = [], transactions: boolean[] = [];
  t.roots.bus.on("trace", () => { throw new Error("observer"); });
  t.roots.bus.on("trace", u => { transactions.push(t.roots.store.db.inTransaction); seen.push(u.traceId); });
  const a = span({ traceId: hex(16), name: "a", kind: "workflow" }), b = span({ traceId: hex(16), name: "b", kind: "workflow" });
  expect((await post(batch([a, b], "p"))).status).toBe(200);
  expect(seen).toEqual([a.traceId, b.traceId]);
  expect(transactions).toEqual([false, false]);
  expect(t.roots.store.getRun(a.traceId)).toBeDefined();
  expect(t.roots.store.getRun(b.traceId)).toBeDefined();
});
it("rejects enclosing Roots transactions before writes while ordinary Store ingestion stays compatible", async () => {
  await setup();
  const b = request(hex(16), "foreign");
  expect(() => t.roots.store.db.transaction(() => t.roots.ingest([b]))()).toThrow(/own its transaction/);
  expect(t.roots.store.getRun(b.spans[0].traceId)).toBeUndefined();
  t.roots.store.db.transaction(() => t.roots.store.ingest([b]))();
  expect(t.roots.store.getRun(b.spans[0].traceId)).toBeDefined();
});
it.each(["generated", "source"])("keeps a pruned direct answer but clears it on %s deletion, even after restart", async (which) => {
  const x = await setup(), r = await x.replay(), generated = r.new_trace_id!;
  CORRELATION_LIMITS.attempts = 1;
  t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p");
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, attribution: "unknown", output_preview: "independently owned answer" });
  expect(t.roots.replays.get(r.id)).not.toHaveProperty("generated_trace_id");
  expect(await (await fetch(t.url + "/api/replays/" + r.id)).json()).not.toHaveProperty("generated_trace_id");
  new Replays(t.roots);
  t.roots.store.deleteRun(which === "generated" ? generated : x.original);
  expect(t.roots.replays.get(r.id)?.output_preview).toBeNull();
  t.roots.ingest([request(generated, r.id)]);
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, output_preview: null });
});
it("retains a locally generated answer when its window was pruned during the provider await", async () => {
  const x = await setup();
  vi.mocked(t.roots.llm.chat).mockImplementation(async () => {
    CORRELATION_LIMITS.attempts = 1;
    t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p");
    return { text: "late owned answer", model: "mock", latencyMs: 0 };
  });
  expect(await x.replay()).toMatchObject({ state: "succeeded", new_trace_id: null, attribution: "unknown", output_preview: "late owned answer" });
});
it("foreign claims revoke direct navigation without erasing or replacing its independent answer", async () => {
  const x = await setup(), r = await x.replay();
  t.roots.ingest([request(r.new_trace_id!, "foreign", "untrusted trace preview")]);
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, attribution: "ambiguous", output_preview: "independently owned answer" });
});
it("does not certify the first of several legitimate session-turn resource matches", async () => {
  await setup();
  const id = "rp_123456789abc";
  t.roots.replays.correlation.open(id, "p");
  for (let i = 0; i < 3; i++) {
    const b = batch([span({ traceId: hex(16), name: "chat-turn", kind: "workflow" })], "p");
    b.resource.attributes.push(s("neatroots.replay.id", id));
    t.roots.ingest([b]);
  }
  expect(t.roots.replays.correlation.select(id)).toMatchObject({ trace: null, attribution: "ambiguous", reason: expect.stringMatching(/possible result traces/) });
});

it("migrates old replay rows without inferring generated-output provenance from navigation", async () => {
  const x = await setup(), r = await x.replay();
  const db = t.roots.store.db;
  db.exec("DROP TRIGGER replay_window_evicted; DROP TRIGGER replay_correlation_deleted; DROP INDEX replays_generated; ALTER TABLE replays DROP COLUMN generated_trace_id");
  new Replays(t.roots);
  expect(db.prepare("SELECT generated_trace_id FROM replays WHERE id=?").get(r.id)).toEqual({ generated_trace_id: null });
  CORRELATION_LIMITS.attempts = 1;
  t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p");
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, output_preview: null, attribution: "unknown" });
});

it("rolls a failed trigger upgrade back with the original deletion and pruning guards intact", async () => {
  const x = await setup(), r = await x.replay();
  const db = t.roots.store.db;
  const guards = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('replay_window_evicted','replay_correlation_deleted') ORDER BY name").all();
  const before = guards(), exec = db.exec.bind(db);
  const fail = vi.spyOn(db, "exec").mockImplementationOnce((sql) =>
    exec(sql.replace("CREATE TRIGGER replay_window_evicted", "SELECT missing_upgrade_function(); CREATE TRIGGER replay_window_evicted")));
  expect(() => new ReplayCorrelation(t.roots.store)).toThrow(/missing_upgrade_function/);
  fail.mockRestore();
  expect(guards()).toEqual(before);
  t.roots.store.deleteRun(r.new_trace_id!);
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, output_preview: null });
  const second = await x.replay();
  CORRELATION_LIMITS.attempts = 1;
  t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p");
  expect(t.roots.replays.get(second.id)).toMatchObject({ new_trace_id: null, output_preview: "independently owned answer" });
});

it.each([false, true])("pending source deletion/reuse cannot restore the old answer (already pruned=%s)", async (pruned) => {
  const x = await setup();
  let release!: () => void;
  const provider = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(t.roots.llm.chat).mockImplementation(async () => { await provider; return { text: "old source answer", model: "mock", latencyMs: 0 }; });
  const pending = x.replay();
  const id = t.roots.replays.forRun(x.original)[0].id;
  if (pruned) { CORRELATION_LIMITS.attempts = 1; t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p"); }
  t.roots.store.deleteRun(x.original);
  t.roots.ingest([request(x.original, "foreign")]);
  release();
  const r = await pending;
  expect(r).toMatchObject({ state: "succeeded", new_trace_id: null, output_preview: null, attribution: "unknown" });
  expect(r).not.toHaveProperty("output_revoked");
  expect(t.roots.replays.get(id)).toMatchObject({ new_trace_id: null, output_preview: null });
  expect(t.roots.store.db.prepare("SELECT output_revoked FROM replays WHERE id=?").get(id)).toEqual({ output_revoked: 1 });
  expect(await (await fetch(t.url + "/api/replays/" + id)).json()).not.toHaveProperty("output_revoked");
});
it("synchronous generated-run deletion/reuse before finish cannot restore its answer", async () => {
  const x = await setup();
  let changed = false;
  t.roots.bus.on("trace", u => {
    if (changed || u.traceId === x.original) return;
    changed = true;
    t.roots.store.deleteRun(u.traceId);
    t.roots.ingest([request(u.traceId, "foreign")]);
  });
  const r = await x.replay();
  expect(changed).toBe(true);
  expect(r).toMatchObject({ new_trace_id: null, output_preview: null, attribution: "unknown" });
  expect(t.roots.replays.get(r.id)?.output_preview).toBeNull();
});
it("a competing connection deleting/reusing the source at final save cannot bypass SQL revocation", async () => {
  const x = await setup(), db = t.roots.store.db;
  const peer = new Store(t.roots.store.dir); readers.push(peer);
  const prepare = db.prepare.bind(db);
  let intercepted = false;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const stmt = prepare(sql);
    if (sql.includes("INSERT INTO replays")) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args: unknown[]) => {
        if (!intercepted && (args[0] as {state?:string})?.state === "succeeded") {
          intercepted = true;
          peer.deleteRun(x.original);
          peer.ingest([request(x.original, "foreign")]);
        }
        return run(...args);
      });
    }
    return stmt;
  });
  const r = await x.replay();
  expect(intercepted).toBe(true);
  expect(r).toMatchObject({ new_trace_id: null, output_preview: null, attribution: "unknown" });
  expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, output_preview: null });
});
