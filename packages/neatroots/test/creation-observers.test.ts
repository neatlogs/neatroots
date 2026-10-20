import { afterEach, expect, it, vi } from "vitest";
import { CORRELATION_LIMITS } from "../src/replay/correlation.js";
import { Store } from "../src/store/db.js";
import { log } from "../src/util/log.js";
import { batch, hex, llmSpan, makeRoots, span, type TestRoots } from "./helpers.js";
let t: TestRoots;
const readers: Store[] = [], limits = { ...CORRELATION_LIMITS };
afterEach(async () => { Object.assign(CORRELATION_LIMITS, limits); vi.restoreAllMocks(); for (const reader of readers.splice(0)) reader.close(); await t?.close(); });
async function setup() {
  t = await makeRoots({ noEngine: true });
  const original = hex(16), root = span({ traceId: original, name: "source", kind: "workflow" });
  const llm = llmSpan(original, root.spanId, { user: "question", out: "old" });
  t.roots.ingest([batch([root, llm], "p")]);
  vi.spyOn(t.roots.llm, "chat").mockResolvedValue({ text: "owned answer", model: "mock", latencyMs: 0 });
  return { original, replay: () => t.roots.replays.replayLlm(original, llm.spanId) };
}
async function saturated() {
  const x = await setup(), old = [await x.replay(), await x.replay()];
  CORRELATION_LIMITS.totalCandidates = 2; CORRELATION_LIMITS.candidates = 2;
  return { ...x, old };
}
it("rolls back all capacity reclamation and new-window writes when replay INSERT fails", async () => {
  const x = await saturated(), db = t.roots.store.db;
  const before = ["replay_windows", "replay_candidates", "replay_trace_claims", "replays"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const events: unknown[] = []; t.roots.bus.on("replay", event => events.push(event));
  vi.mocked(t.roots.llm.chat).mockClear();
  db.exec("CREATE TRIGGER abort_creation BEFORE INSERT ON replays WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'creation SQL failed'); END");
  await expect(x.replay()).rejects.toThrow(/creation SQL failed/);
  expect(["replay_windows", "replay_candidates", "replay_trace_claims", "replays"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(events).toEqual([]); expect(t.roots.llm.chat).not.toHaveBeenCalled();
});
it("isolates creation and every eviction observer after one visible committed transition", async () => {
  const x = await saturated(), reader = new Store(t.roots.store.dir); readers.push(reader);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const seen: { id: string; state: string; previous_trace_id?: string | null }[] = [], wildcard: string[] = [], visibility: boolean[] = [];
  t.roots.bus.on("replay", () => { throw new Error("typed creation observer"); });
  t.roots.bus.on("replay", event => {
    seen.push(event);
    visibility.push(!t.roots.store.db.inTransaction && !!reader.db.prepare("SELECT 1 FROM replays WHERE id=?").get(event.id)
      && x.old.every(r => (reader.db.prepare("SELECT new_trace_id FROM replays WHERE id=?").get(r.id) as { new_trace_id: string | null }).new_trace_id === null));
  });
  t.roots.bus.onAny(() => { throw new Error("wildcard creation observer"); });
  t.roots.bus.onAny(event => { if (event.event === "replay") wildcard.push((event.payload as { id: string }).id); });
  const fresh = await x.replay();
  expect(fresh).toMatchObject({ state: "succeeded", attribution: "explicit", output_preview: "owned answer" });
  expect(seen.map(e => e.id)).toEqual([fresh.id, ...x.old.map(r => r.id), fresh.id]);
  expect(wildcard).toEqual(seen.map(e => e.id)); expect(visibility).toEqual([true, true, true, true]);
  for (const r of x.old) expect(seen).toContainEqual(expect.objectContaining({ id: r.id, previous_trace_id: r.new_trace_id, new_trace_id: null, attribution: "unknown" }));
  expect(warn.mock.calls.some(([message]) => String(message).includes("typed creation observer"))).toBe(true);
  expect(warn.mock.calls.some(([message]) => String(message).includes("wildcard creation observer"))).toBe(true);
});
it("does not misclassify committed completion when a completion subscriber throws", async () => {
  const x = await setup();
  vi.spyOn(log, "warn").mockImplementation(() => {});
  t.roots.bus.on("replay", event => { if (event.state === "succeeded") throw new Error("completion observer"); });
  const r = await x.replay();
  expect(r).toMatchObject({ state: "succeeded", error: null, attribution: "explicit", output_preview: "owned answer" });
  expect(t.roots.replays.get(r.id)).toEqual(r);
});
it("rejects caller-owned creation transactions before mutation or provider execution", async () => {
  const x = await saturated(), db = t.roots.store.db;
  const count = () => db.prepare("SELECT * FROM replay_windows ORDER BY rowid").all(), before = count();
  let pending!: ReturnType<typeof x.replay>;
  db.transaction(() => { pending = x.replay(); })();
  await expect(pending).rejects.toThrow(/creation must own its transaction/);
  expect(count()).toEqual(before); expect(t.roots.replays.forRun(x.original)).toHaveLength(2);
  expect(t.roots.llm.chat).toHaveBeenCalledTimes(2);
});
it("keeps genuine provider failures failed while isolating failure observers", async () => {
  const x = await setup();
  vi.mocked(t.roots.llm.chat).mockRejectedValue(new Error("provider failed"));
  vi.spyOn(log, "warn").mockImplementation(() => {});
  t.roots.bus.on("replay", event => { if (event.state === "failed") throw new Error("failure observer"); });
  expect(await x.replay()).toMatchObject({ state: "failed", error: "provider failed", new_trace_id: null });
});
