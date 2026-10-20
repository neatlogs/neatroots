import { afterEach, expect, it, vi } from "vitest";
import { Replays } from "../src/replay/replay.js";
import { batch, hex, llmSpan, makeRoots, span, type TestRoots } from "./helpers.js";
let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });
async function setup() {
  t = await makeRoots({ noEngine: true });
  const original = hex(16), root = span({ traceId: original, name: "source", kind: "workflow" });
  const llm = llmSpan(original, root.spanId, { user: "question", out: "old" });
  t.roots.ingest([batch([root, llm], "p")]);
  vi.spyOn(t.roots.llm, "chat").mockResolvedValue({ text: "owned answer", model: "mock", latencyMs: 0 });
  return { original, replay: () => t.roots.replays.replayLlm(original, llm.spanId), llm };
}
// Eight realistic, individually bounded closed windows fill the global pool well
// below the 256-window bound. The first has an actual generated run and answer.
function fill(first: string, active = false) {
  const db = t.roots.store.db;
  db.transaction(() => {
    const add = db.prepare("INSERT INTO replay_candidates(replay_id,trace_id,eligible,authority,claimed) VALUES (?,?,1,1,1)");
    for (let window = 0; window < 8; window++) {
      const id = window === 0 ? first : `rp_${window.toString(16).padStart(12, "0")}`;
      if (window) db.prepare("INSERT INTO replay_windows VALUES (?, 'p', ?, 0, 0)").run(id, Number(active));
      else db.prepare("UPDATE replay_windows SET active=? WHERE replay_id=?").run(Number(active), id);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM replay_candidates WHERE replay_id=?").get(id) as { n: number }).n;
      for (let j = n; j < 512; j++) add.run(id, (10000 + window * 512 + j).toString(16).padStart(32, "0"));
    }
  })();
  expect(count("replay_candidates")).toBe(4096);
  expect(count("replay_windows")).toBe(8);
}
function count(table: string) {
  return (t.roots.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
it("recovers sequential explicit replays from closed saturation and notifies the old destination", async () => {
  const x = await setup(), old = await x.replay(); fill(old.id);
  const db = t.roots.store.db;
  const retained = db.prepare("SELECT * FROM replay_candidates WHERE replay_id='rp_000000000001'").all();
  const events: unknown[] = [];
  t.roots.bus.on("replay", e => events.push(e));
  const fresh = await x.replay();
  expect(fresh).toMatchObject({ state: "succeeded", attribution: "explicit", output_preview: "owned answer" });
  expect(fresh.new_trace_id).toBeTruthy();
  expect(t.roots.replays.get(old.id)).toMatchObject({ attribution: "unknown", new_trace_id: null, output_preview: "owned answer" });
  expect(events).toContainEqual(expect.objectContaining({ id: old.id, trace_id: x.original, previous_trace_id: old.new_trace_id, new_trace_id: null, attribution: "unknown" }));
  expect(db.prepare("SELECT * FROM replay_candidates WHERE replay_id='rp_000000000001'").all()).toEqual(retained);
  expect(count("replay_candidates")).toBe(3585);
  // Repeated sequential attempts recover immediately rather than waiting for 256 opens.
  for (let i = 0; i < 12; i++) expect(await x.replay()).toMatchObject({ attribution: "explicit" });
  expect(count("replay_candidates")).toBeLessThanOrEqual(4096);
  expect(count("replay_windows")).toBeLessThanOrEqual(256);
  expect(db.prepare("SELECT 1 FROM replay_candidates GROUP BY replay_id HAVING COUNT(*)>512").get()).toBeUndefined();
});
it.each(["source", "generated"])("capacity pruning preserves the owned answer until %s deletion", async which => {
  const x = await setup(), old = await x.replay(); fill(old.id);
  expect(await x.replay()).toMatchObject({ attribution: "explicit" });
  expect(t.roots.replays.get(old.id)?.output_preview).toBe("owned answer");
  t.roots.store.deleteRun(which === "source" ? x.original : old.new_trace_id!);
  expect(t.roots.replays.get(old.id)).toMatchObject({ output_preview: null, new_trace_id: null, attribution: "unknown" });
});
it("does not reclaim active candidate evidence when active windows alone saturate the pool", async () => {
  const x = await setup(), old = await x.replay(); fill(old.id, true);
  const before = t.roots.store.db.prepare("SELECT replay_id,trace_id,eligible,authority,claimed,deleted FROM replay_candidates ORDER BY replay_id,trace_id").all();
  expect(await x.replay()).toMatchObject({ attribution: "unknown", new_trace_id: null });
  expect(count("replay_candidates")).toBe(4096);
  expect(t.roots.store.db.prepare("SELECT replay_id,trace_id,eligible,authority,claimed,deleted FROM replay_candidates ORDER BY replay_id,trace_id").all()).toEqual(before);
  expect(count("replay_windows")).toBe(9);
});
it("reclaims persisted closed history after reopening the replay registry", async () => {
  const x = await setup(), old = await x.replay(); fill(old.id);
  const reopened = new Replays(t.roots);
  expect(await reopened.replayLlm(x.original, x.llm.spanId)).toMatchObject({ attribution: "explicit" });
  expect(reopened.get(old.id)).toMatchObject({ new_trace_id: null, attribution: "unknown", output_preview: "owned answer" });
});
it("rolls back whole-window reclamation if opening the new window fails", async () => {
  const x = await setup(), old = await x.replay(); fill(old.id);
  const db = t.roots.store.db;
  db.exec("CREATE TRIGGER fail_open BEFORE INSERT ON replay_windows BEGIN SELECT RAISE(ABORT,'open failed'); END");
  expect(() => t.roots.replays.correlation.open("rp_aaaaaaaaaaaa", "p")).toThrow(/open failed/);
  expect(count("replay_candidates")).toBe(4096);
  expect(t.roots.replays.get(old.id)).toMatchObject({ new_trace_id: old.new_trace_id, attribution: "explicit", output_preview: "owned answer" });
});
