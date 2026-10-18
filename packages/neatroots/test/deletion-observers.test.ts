import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { log } from "../src/util/log.js";
import { batch, hex, llmSpan, makeRoots, s, span, type TestRoots } from "./helpers.js";
let t: TestRoots;
const readers: Store[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const reader of readers.splice(0)) reader.close(); await t?.close(); });
async function setup() {
  t = await makeRoots({ noEngine: true, serve: true });
  const original = hex(16), root = span({ traceId: original, name: "source", kind: "workflow" });
  const llm = llmSpan(original, root.spanId, { user: "question", out: "old" });
  t.roots.ingest([batch([root, llm], "p")]);
  vi.spyOn(t.roots.llm, "chat").mockResolvedValue({ text: "owned answer", model: "mock", latencyMs: 0 });
  const a = await t.roots.replays.replayLlm(original, llm.spanId), b = await t.roots.replays.replayLlm(original, llm.spanId);
  return { original, replays: [a, b] };
}
it.each(["direct", "http"])("isolates synchronous replay and wildcard observers during %s deletion", async via => {
  const x = await setup(), reader = new Store(t.roots.store.dir); readers.push(reader);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const seen: string[] = [], wildcard: string[] = [], visible: boolean[] = [];
  t.roots.bus.on("replay", () => { throw new Error("replay observer"); });
  t.roots.bus.on("replay", event => { seen.push(event.id); visible.push(!reader.getRun(x.original) && !t.roots.store.db.inTransaction); });
  t.roots.bus.onAny(() => { throw new Error("wildcard observer"); });
  t.roots.bus.onAny(event => { if (event.event === "replay") wildcard.push((event.payload as { id: string }).id); });
  if (via === "direct") expect(() => t.roots.store.deleteRun(x.original)).not.toThrow();
  else expect((await fetch(t.url + "/api/runs/" + x.original, { method: "DELETE" })).status).toBe(200);
  expect(seen.sort()).toEqual(x.replays.map(r => r.id).sort());
  expect(wildcard.sort()).toEqual(seen);
  expect(visible).toEqual([true, true]);
  expect(t.roots.store.getRun(x.original)).toBeUndefined();
  for (const r of x.replays) expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: null, output_preview: null, attribution: "unknown" });
  expect(warn.mock.calls.some(([message]) => String(message).includes("replay observer"))).toBe(true);
  expect(warn.mock.calls.some(([message]) => String(message).includes("wildcard observer"))).toBe(true);
});
it("isolates Store subscribers individually and exposes committed deletion to the next subscriber", async () => {
  const x = await setup(), reader = new Store(t.roots.store.dir); readers.push(reader);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {}), seen: string[][] = [];
  t.roots.store.onRunsDeleted(() => { throw new Error("store observer"); });
  t.roots.store.onRunsDeleted(ids => { expect(reader.getRun(x.original)).toBeUndefined(); expect(t.roots.store.db.inTransaction).toBe(false); seen.push(ids); });
  expect(() => t.roots.store.deleteRuns([x.original])).not.toThrow();
  expect(seen).toEqual([[x.original]]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("store observer"));
});
it("propagates canonical SQL aborts without deletion notifications or persisted run changes", async () => {
  const x = await setup(), events: unknown[] = [];
  t.roots.bus.on("replay", event => events.push(event));
  const subscriber = vi.fn(); t.roots.store.onRunsDeleted(subscriber);
  t.roots.store.db.exec("CREATE TRIGGER abort_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'canonical delete failed'); END");
  expect(() => t.roots.store.deleteRun(x.original)).toThrow(/canonical delete failed/);
  expect(t.roots.store.getRun(x.original)).toBeDefined();
  expect(events).toEqual([]); expect(subscriber).not.toHaveBeenCalled();
  for (const r of x.replays) expect(t.roots.replays.get(r.id)).toMatchObject({ new_trace_id: r.new_trace_id, output_preview: "owned answer", attribution: "explicit" });
});

it.each(["deleteRun", "deleteRuns"] as const)("rejects nested %s before canonical rows, blob cleanup or observer effects", async method => {
  const x = await setup(), db = t.roots.store.db, payload = "unique nested deletion payload".repeat(4000);
  const large = span({ traceId: x.original, name: "large", kind: "tool", attrs: [s("payload", payload)] });
  t.roots.ingest([batch([large], "p")]);
  const row = db.prepare("SELECT blobs FROM spans WHERE trace_id=? AND span_id=?").get(x.original, large.spanId) as { blobs: string };
  const sha = (JSON.parse(row.blobs) as string[])[0];
  expect(t.roots.store.blobs.get(sha)).toBe(payload);
  const snapshot = () => ["runs", "spans", "replays", "replay_windows", "replay_candidates", "replay_trace_claims"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot(), events: unknown[] = [];
  t.roots.bus.on("replay", event => events.push(event));
  const subscriber = vi.fn(); t.roots.store.onRunsDeleted(subscriber);
  let nestedError: unknown, duringRows: unknown, duringBlobPresent = false;
  expect(() => db.transaction(() => {
    try {
      if (method === "deleteRun") t.roots.store.deleteRun(x.original);
      else t.roots.store.deleteRuns([x.original]);
    } catch (error) { nestedError = error; }
    duringRows = snapshot(); duringBlobPresent = t.roots.store.blobs.get(sha) === payload;
    throw new Error("outer rollback");
  })()).toThrow("outer rollback");
  expect(nestedError).toBeInstanceOf(Error);
  expect((nestedError as Error).message).toMatch(/deleteRuns must own its transaction/);
  expect(duringRows).toEqual(before); expect(duringBlobPresent).toBe(true);
  expect(snapshot()).toEqual(before); expect(t.roots.store.blobs.get(sha)).toBe(payload);
  expect(events).toEqual([]); expect(subscriber).not.toHaveBeenCalled();
});
it("keeps an empty deletion list a no-op inside a caller transaction", async () => {
  const x = await setup(), subscriber = vi.fn(); t.roots.store.onRunsDeleted(subscriber);
  t.roots.store.db.transaction(() => { expect(() => t.roots.store.deleteRuns([])).not.toThrow(); })();
  expect(t.roots.store.getRun(x.original)).toBeDefined(); expect(subscriber).not.toHaveBeenCalled();
});
