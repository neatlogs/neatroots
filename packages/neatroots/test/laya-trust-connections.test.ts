import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { questionSignature, type DecisionQuestion } from "../src/models/decision.js";
import { Store } from "../src/store/db.js";
import { tmpHome } from "./helpers.js";

const q: DecisionQuestion = { name: "approval", type: "yes_no", ask: "Was approval missing?" };
const other: DecisionQuestion = { ...q, name: "lookup", ask: "Was lookup missing?" };
const stores: Store[] = [];
const homes: string[] = [];
const home = () => { const dir = tmpHome(); homes.push(dir); return dir; };
const open = (dir: string) => { const store = new Store(dir); stores.push(store); return store; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("adds observations from independent connections without losing either writer on close", () => {
  const dir = home(); const a = open(dir); const b = open(dir);
  const first = a.trustStore(); const second = b.trustStore();
  first.record(q, true); second.record(q, false); first.record(other, true);
  a.close(); b.close();
  const current = open(dir).trustStore();
  expect(current.get(q)).toEqual({ n: 2, agree: 1 });
  expect(current.get(other)).toEqual({ n: 1, agree: 1 });
});

it("cannot restore a stale trusted ratio by discarding another connection's disagreement", () => {
  const dir = home(); const seed = open(dir);
  for (let i = 0; i < 30; i++) seed.trustStore().record(q, i < 27);
  seed.close();
  const a = open(dir); const b = open(dir);
  const first = a.trustStore(); const second = b.trustStore();
  first.record(q, false); a.close();
  second.record(other, true); b.close();
  const stats = open(dir).trustStore().get(q);
  expect(stats).toEqual({ n: 31, agree: 27 });
  expect(stats.agree / stats.n).toBeLessThan(0.9);
});

it("does not overwrite observations when a stale connection only activates a definition", () => {
  const dir = home(); const a = open(dir); const b = open(dir);
  const first = a.trustStore(); const second = b.trustStore();
  first.record(q, true); a.close();
  second.activate?.(other); b.close();
  const current = open(dir).trustStore();
  expect(current.get(q)).toEqual({ n: 1, agree: 1 });
  expect(current.all()).toMatchObject({ approval: { n: 1, agree: 1 }, lookup: { n: 0, agree: 0 } });
});

it("refreshes get/all across existing connections and respects an external metadata reset", () => {
  const dir = home(); const a = open(dir); const b = open(dir);
  const first = a.trustStore(); const second = b.trustStore();
  expect(first).toBe(a.trustStore());
  second.record(q, true);
  expect(first.get(q)).toEqual({ n: 1, agree: 1 });
  expect(first.all()).toMatchObject({ approval: { n: 1, agree: 1 } });
  b.setMeta("laya_trust", "{}");
  expect(first.get(q)).toEqual({ n: 0, agree: 0 });
  expect(first.all()).toEqual({});
  first.record(q, false);
  expect(second.get(q)).toEqual({ n: 1, agree: 0 });
});

it("keeps lookups, unchanged activation, name-only observations and close free of metadata writes", () => {
  const store = open(home()); const trust = store.trustStore();
  trust.activate?.(q);
  const write = vi.spyOn(store, "setMeta");
  for (let i = 0; i < 3; i++) { trust.get(q); trust.all(); }
  trust.activate?.(q); trust.record(q.name, true);
  store.close();
  expect(write).not.toHaveBeenCalled();
});

it("validates current persisted counters and retries cleanly after a rolled-back write", () => {
  const dir = home(); const a = open(dir); const b = open(dir);
  const trust = a.trustStore(); const sig = questionSignature(q);
  b.setMeta("laya_trust", JSON.stringify({ approval: { activeSig: sig, defs: { [sig]: { n: 1, agree: 2 } } } }));
  expect(trust.get(q)).toEqual({ n: 0, agree: 0 });
  const write = vi.spyOn(a, "setMeta").mockImplementationOnce(() => { throw new Error("write failed"); });
  expect(() => trust.record(q, true)).toThrow("write failed");
  expect(a.db.inTransaction).toBe(false);
  expect(trust.get(q)).toEqual({ n: 0, agree: 0 });
  write.mockRestore();
  trust.record(q, false);
  expect(b.trustStore().get(q)).toEqual({ n: 1, agree: 0 });
});

it("ignores late shadow observations and closed-handle reads without querying closed SQLite", () => {
  const dir = home(); const store = open(dir); const trust = store.trustStore();
  trust.record(q, true); store.close();
  const read = vi.spyOn(store, "getMeta"); const write = vi.spyOn(store, "setMeta");
  expect(() => { trust.record(q, false); trust.activate?.(other); }).not.toThrow();
  expect(trust.get(q)).toEqual({ n: 0, agree: 0 });
  expect(trust.all()).toEqual({});
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  expect(open(dir).trustStore().get(q)).toEqual({ n: 1, agree: 1 });
});
