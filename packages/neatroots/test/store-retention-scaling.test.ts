import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { batch, hex, s, span, tmpHome } from "./helpers.js";

const stores: Store[] = [];
const homes: string[] = [];
function store(): Store {
  const home = tmpHome();
  homes.push(home);
  const st = new Store(path.join(home, "data"));
  stores.push(st);
  return st;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const st of stores.splice(0)) st.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function seedLogs(st: Store, count: number): void {
  const insert = st.db.prepare("INSERT INTO logs (body, received_ms) VALUES (?, ?)");
  st.db.transaction(() => {
    // Reverse timestamps, with ties: retention must use received_ms/id, not insertion order.
    for (let i = 0; i < count; i++) insert.run("x".repeat(256), Math.floor((count - i) / 2));
  })();
}

it("uses an ordered index for bounded traceless-log batches, including reopened legacy stores", () => {
  const st = store();
  seedLogs(st, 520);
  // Simulate a database made before the retention index existed.
  st.db.exec("DROP INDEX IF EXISTS logs_traceless_received");
  const dir = path.join(homes[0], "data");
  stores.pop()!.close();
  const reopened = new Store(dir);
  stores.push(reopened);
  // Use the same index constraint as the production batch: without it SQLite can prefer
  // logs_trace plus a whole-result sort, even when the partial ordered index exists.
  const plan = reopened.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM logs INDEXED BY logs_traceless_received WHERE trace_id IS NULL ORDER BY received_ms, id LIMIT 256").all() as { detail: string }[];
  expect(plan.some((row) => /logs_traceless_received/.test(row.detail))).toBe(true);
  expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
});

it("refreshes blob accounting after age deletion and on later sweeps, including a missing payload", () => {
  const st = store();
  const pinned = hex(16);
  const old = hex(16);
  const payload = "p".repeat(40_000);
  const pinnedSpan = span({ traceId: pinned, name: "pinned", kind: "workflow", attrs: [s("payload", payload)] });
  st.ingest([batch([pinnedSpan, span({ traceId: old, name: "old", kind: "workflow", attrs: [s("payload", "o".repeat(200_000))] })])]);
  st.setPinned(pinned, true);
  st.db.prepare("UPDATE runs SET received_ms = 0, ended_ms = 0").run();
  const sha = JSON.parse((st.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(pinned) as { blobs: string }).blobs)[0] as string;
  st.blobs.delete(sha);
  const blobSize = vi.spyOn(st.blobs, "size");
  // The old run's blob must be deleted before the snapshot, and a missing pinned blob counts 0.
  expect(st.sweep(1, Number.POSITIVE_INFINITY)).toBe(1);
  expect(blobSize).toHaveBeenCalledTimes(1);
  expect(blobSize.mock.results[0].value).toBe(0);
  expect(st.getRun(pinned)).toBeDefined();
  st.ingest([batch([pinnedSpan])]); // An exporter retry restores the missing payload.
  expect(st.blobs.get(sha)).toBe(payload);
  blobSize.mockClear();
  expect(st.sweep(1, Number.POSITIVE_INFINITY)).toBe(0);
  expect(blobSize).toHaveBeenCalledTimes(1);
  expect(blobSize.mock.results[0].value).toBe(Buffer.byteLength(payload));
});

it.each([25_000, 100_000])("bounds a size sweep over %i traceless logs without repeated blob walks", (count) => {
  const st = store();
  const pinned = hex(16);
  const unpinned = hex(16);
  for (const traceId of [pinned, unpinned]) {
    st.ingest([batch([span({ traceId, name: "keep", kind: "workflow", attrs: [s("payload", "b".repeat(40_000))] })])]);
  }
  st.setPinned(pinned, true);
  st.db.prepare("INSERT INTO logs (trace_id, body, received_ms) VALUES (?, 'traced', 0)").run(unpinned);
  seedLogs(st, count);
  const cap = Math.floor(st.storedBytes() * 0.25);
  const blobSize = vi.spyOn(st.blobs, "size");
  const started = performance.now();
  const removed = st.sweep(0, cap);
  const elapsed = performance.now() - started;
  console.info(`retention ${count} logs: ${elapsed.toFixed(1)} ms, ${blobSize.mock.calls.length} blob walk(s)`);
  // Time only the sweep, not setup. Five seconds gives ample CI headroom for indexed batches,
  // while rejecting the reported 15-second 100k-log quadratic sweep. Structural checks above
  // and the constant walk count below catch the regression independently of machine speed.
  expect(elapsed).toBeLessThan(5_000);
  expect(blobSize).toHaveBeenCalledTimes(1);
  expect(removed).toBe(0);
  expect(st.getRun(pinned)).toBeDefined();
  expect(st.getRun(unpinned)).toBeDefined();
  expect(st.db.prepare("SELECT body FROM logs WHERE trace_id = ?").get(unpinned)).toEqual({ body: "traced" });
  expect(st.storedBytes()).toBeLessThanOrEqual(cap);
  const remaining = st.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE trace_id IS NULL").get() as { n: number };
  expect(remaining.n).toBeGreaterThan(0);
  expect(remaining.n).toBeLessThan(count / 2);
  // All deleted logs precede every survivor, even with out-of-order receipt times and ties.
  const oldest = st.db.prepare("SELECT id FROM logs WHERE trace_id IS NULL ORDER BY received_ms, id LIMIT 1").get() as { id: number };
  const expected = st.db.prepare("SELECT id FROM logs WHERE trace_id IS NULL ORDER BY received_ms, id").all() as { id: number }[];
  const original = Array.from({ length: count }, (_, i) => ({ id: i + 2, received: Math.floor((count - i) / 2) }))
    .sort((a, b) => a.received - b.received || a.id - b.id);
  expect(expected.map((row) => row.id)).toEqual(original.slice(original.findIndex((row) => row.id === oldest.id)).map((row) => row.id));
  blobSize.mockClear();
  expect(st.sweep(0, cap)).toBe(0);
  expect(blobSize).toHaveBeenCalledTimes(1);
  expect((st.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE trace_id IS NULL").get() as { n: number }).n).toBe(remaining.n);
});
