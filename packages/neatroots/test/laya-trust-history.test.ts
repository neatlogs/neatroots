import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createTrustStore, questionSignature, type StoredTrustRecord } from "../src/models/trust.js";
import type { DecisionQuestion } from "../src/models/decision.js";
import { Store } from "../src/store/db.js";
import { tmpHome } from "./helpers.js";

const q = (i: number, name = "q"): DecisionQuestion => ({ name, type: "yes_no", ask: `Question ${i}?` });
const zero = { n: 0, agree: 0 };
const sig = (i: number) => questionSignature(q(i));
const rows = (count: number, defs = 1): Record<string, StoredTrustRecord> => Object.fromEntries(
  Array.from({ length: count }, (_, i) => [`name-${i}`, { activeSig: sig(0), defs: Object.fromEntries(
    Array.from({ length: defs }, (_, j) => [sig(j), { n: 30, agree: 27 }]),
  ) }]),
);
const stores: Store[] = [];
const homes: string[] = [];
const open = (home: string) => { const s = new Store(home); stores.push(s); return s; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) if (s.db.open) s.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

it("forgets whole old definitions instead of carrying trusted counters into reactivation", () => {
  let saved: Record<string, StoredTrustRecord> = {};
  const trust = createTrustStore(undefined, data => { saved = structuredClone(data); });
  for (let n = 0; n < 30; n++) trust.record(q(0), n < 27);
  for (let i = 1; i <= 32; i++) trust.record(q(i), false);
  expect(Object.keys(saved.q.defs)).toHaveLength(32);
  expect(trust.get(q(0))).toEqual(zero);
  expect(trust.get("q")).toEqual(zero); // active pointer is not redirected to another definition
  expect(trust.get(q(1))).toEqual({ n: 1, agree: 0 });
  trust.activate?.(q(0));
  expect(trust.get(q(0))).toEqual(zero);
  trust.record(q(0), true);
  expect(trust.get(q(0))).toEqual({ n: 1, agree: 1 });
  expect(trust.get(q(1))).toEqual(zero);
  expect(trust.get(q(2))).toEqual({ n: 1, agree: 0 });
});

it("bounds loaded global definitions deterministically and leaves survivors unchanged", () => {
  const initial = rows(33, 32); const write = vi.fn();
  const trust = createTrustStore(initial, write);
  expect(trust.get(q(0, "name-0"))).toEqual(zero);
  expect(trust.get(q(31, "name-0"))).toEqual(zero);
  expect(trust.get(q(0, "name-1"))).toEqual({ n: 30, agree: 27 });
  expect(trust.get(q(31, "name-32"))).toEqual({ n: 30, agree: 27 });
  expect(initial["name-0"].defs[sig(0)]).toEqual({ n: 30, agree: 27 });
  expect(write).not.toHaveBeenCalled();
  let saved: Record<string, StoredTrustRecord> = {};
  const mutable = createTrustStore(initial, data => { saved = data; });
  mutable.record(q(0, "name-32"), false);
  expect(Object.values(saved).reduce((n, row) => n + Object.keys(row.defs).length, 0)).toBe(1024);
  expect(mutable.get(q(0, "name-32"))).toEqual({ n: 31, agree: 27 });
});

it("bounds named and empty activation rows without writing on read or unchanged activation", () => {
  const write = vi.fn(); const trust = createTrustStore(rows(1025, 0), write);
  expect(Object.keys(trust.all())).toHaveLength(1024);
  expect(trust.all()).not.toHaveProperty("name-0");
  trust.get(q(0, "name-1")); trust.record("name-1", true); trust.activate?.(q(0, "name-1"));
  expect(write).not.toHaveBeenCalled();
  const fresh = createTrustStore(undefined, write);
  for (let i = 0; i < 1025; i++) fresh.activate?.(q(0, `active-${i}`));
  expect(Object.keys(fresh.all())).toHaveLength(1024);
  expect(fresh.all()).not.toHaveProperty("active-0");
});

it("enforces actual UTF-8 serialized bytes, including escaping and oversized single names", () => {
  let saved: Record<string, StoredTrustRecord> = {};
  const trust = createTrustStore(undefined, data => { saved = structuredClone(data); });
  for (let i = 0; i < 80; i++) trust.record(q(i, `${i}-` + "\"\n漢😀".repeat(500)), true);
  expect(Buffer.byteLength(JSON.stringify(saved), "utf8")).toBeLessThanOrEqual(256 * 1024);
  expect(Object.keys(saved).length).toBeGreaterThan(0);
  expect(Object.keys(saved).length).toBeLessThan(80);
  const oversized = q(0, "漢".repeat(100_000));
  trust.record(oversized, true);
  expect(trust.get(oversized)).toEqual(zero);
  expect(Buffer.byteLength(JSON.stringify(saved), "utf8")).toBeLessThanOrEqual(256 * 1024);
});

it("projects oversized persisted bytes without eager persistence or legacy promotion", () => {
  const initial = rows(2); initial["漢".repeat(100_000)] = { defs: { [sig(0)]: { n: 100, agree: 100 } } };
  const write = vi.fn(); const trust = createTrustStore({ ...initial, legacy: { n: 100, agree: 100 }, invalid: { defs: { [sig(0)]: { n: 1, agree: 2 } } } }, write);
  expect(trust.get(q(0, "漢".repeat(100_000)))).toEqual(zero);
  expect(trust.get("legacy")).toEqual(zero);
  expect(trust.get(q(0, "invalid"))).toEqual(zero);
  trust.all(); trust.record("legacy", true);
  expect(write).not.toHaveBeenCalled();
});

it("never revives evicted counters across connections, failed writes, retry and reopen", () => {
  const home = tmpHome(); homes.push(home); const a = open(home); const b = open(home);
  const first = a.trustStore(); const second = b.trustStore();
  for (let n = 0; n < 30; n++) first.record(q(0), n < 27);
  expect(second.get(q(0))).toEqual({ n: 30, agree: 27 });
  for (let i = 1; i <= 32; i++) first.record(q(i), false);
  expect(second.get(q(0))).toEqual(zero);
  const before = a.getMeta("laya_trust");
  const write = vi.spyOn(b, "setMeta").mockImplementationOnce(() => { throw new Error("history write failed"); });
  expect(() => second.record(q(0), true)).toThrow("history write failed");
  expect(b.db.inTransaction).toBe(false);
  expect(a.getMeta("laya_trust")).toBe(before);
  expect(first.get(q(1))).toEqual({ n: 1, agree: 0 });
  write.mockRestore(); second.record(q(0), false);
  expect(first.get(q(0))).toEqual({ n: 1, agree: 0 });
  expect(first.get(q(1))).toEqual(zero);
  first.record(q(0), true);
  a.close(); b.close();
  const reopened = open(home); const trust = reopened.trustStore();
  expect(trust.get(q(0))).toEqual({ n: 2, agree: 1 });
  expect(trust.get(q(1))).toEqual(zero);
  expect(Object.keys(JSON.parse(reopened.getMeta("laya_trust")!).q.defs)).toHaveLength(32);
});

it("projects existing oversized Store metadata purely then persists bounds on a genuine mutation", () => {
  const home = tmpHome(); homes.push(home); const store = open(home);
  store.setMeta("laya_trust", JSON.stringify(rows(33, 32)));
  const before = store.getMeta("laya_trust"); const write = vi.spyOn(store, "setMeta");
  const trust = store.trustStore();
  expect(trust.get(q(0, "name-0"))).toEqual(zero);
  trust.all(); trust.record("name-1", true); trust.activate?.(q(0, "name-1"));
  expect(write).not.toHaveBeenCalled();
  expect(store.getMeta("laya_trust")).toBe(before);
  trust.record(q(0, "name-1"), false);
  const persisted = JSON.parse(store.getMeta("laya_trust")!);
  expect(Object.values(persisted).reduce((n: number, r: any) => n + Object.keys(r.defs).length, 0)).toBe(1024);
  expect(trust.get(q(0, "name-1"))).toEqual({ n: 31, agree: 27 });
});

it("does not migrate an oversized raw-active row when activation ends at the same bounded state", () => {
  const home = tmpHome(); homes.push(home); const store = open(home);
  const oversized = q(0, "漢".repeat(100_000)); const signature = questionSignature(oversized);
  store.setMeta("laya_trust", JSON.stringify({ [oversized.name]: {
    activeSig: signature, defs: { [signature]: { n: 30, agree: 27 } },
  } }));
  const raw = store.getMeta("laya_trust"); const write = vi.spyOn(store, "setMeta");
  const trust = store.trustStore();
  expect(trust.get(oversized)).toEqual(zero);
  expect(trust.all()).toEqual({});
  trust.activate?.(oversized);
  expect(write).not.toHaveBeenCalled();
  expect(store.getMeta("laya_trust")).toBe(raw);
  trust.record(q(1), false);
  expect(write).toHaveBeenCalledTimes(1);
  expect(trust.get(q(1))).toEqual({ n: 1, agree: 0 });
  expect(trust.get(oversized)).toEqual(zero);
  expect(Buffer.byteLength(store.getMeta("laya_trust")!, "utf8")).toBeLessThanOrEqual(256 * 1024);
});
