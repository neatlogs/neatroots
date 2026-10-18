import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Retention } from "../src/retention.js";
import { backfillBlobReferences, reclaimPendingBlobs, type RetentionCandidate } from "../src/store/retention-state.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore } from "./helpers.js";
import { Store } from "../src/store/db.js";
import { SearchIds } from "../src/store/search-ids.js";
import { runDatabaseWeights } from "../src/store/retention.js";

const homes: string[] = [];
const schedulers: Retention[] = [];
function setup() { const home = tmpHome(); homes.push(home); return trackedStore(path.join(home, "data")); }
function send(st: Store, traceId = hex(16), spanId = hex(8), payload = "payload") {
  st.ingest([batch([span({ traceId, spanId, name: "test", kind: "tool", attrs: [s("payload", payload)] })])]);
  return { traceId, spanId };
}
function candidate(st: Store, id: string): RetentionCandidate {
  return st.db.prepare("SELECT trace_id, retention_revision FROM runs WHERE trace_id = ?").get(id) as RetentionCandidate;
}
function ready(st: Store) { while (!backfillBlobReferences(st.db, 2)) { /* bounded test fixture */ } }
function scheduler(st: Store) { const value = new Retention(st); schedulers.push(value); return value; }

it("attributes optional reference table/index pages to runs and supports the older schema", () => {
  const st = setup();
  for (let i = 0; i < 80; i++) send(st, undefined, undefined, "shared".repeat(10_000));
  const page = st.db.pragma("page_size", { simple: true }) as number;
  const owned = (st.db.prepare(`SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name IN
    (SELECT name FROM sqlite_schema WHERE tbl_name IN ('retention_blob_refs','retention_ref_errors') AND rootpage>0)
    GROUP BY name`).all() as { bytes: number }[]).reduce((n,row)=>n+Math.max(0,row.bytes-page),0);
  expect(owned).toBeGreaterThan(0);
  const total = () => [...runDatabaseWeights(st.db)!.values()].reduce((n,value)=>n+value,0);
  const withReferences = total();
  st.db.exec("DROP TABLE retention_blob_refs; DROP TABLE retention_ref_errors");
  const legacy = total();
  expect(withReferences - legacy).toBeCloseTo(owned, 6);
});

it("hides committed index tombstones in ready, fallback, global and run searches before bounded GC", () => {
  const st = setup();
  const traceId = hex(16), spanId = hex(8);
  st.ingest([batch([span({ traceId, spanId, name: "uniqueneedle", kind: "tool" })])]);
  expect(st.searchSpans("uniqueneedle")).toHaveLength(1);
  expect(st.deleteRetentionCandidate(candidate(st, traceId))).toBe("removed");
  expect(st.getRun(traceId)).toBeUndefined();
  expect(st.db.prepare("SELECT COUNT(*) n FROM span_fts_ids").get()).toEqual({ n: 1 });
  expect(st.searchSpans("uniqueneedle")).toEqual([]);
  expect(st.searchSpans("uniqueneedle", 50, [traceId])).toEqual([]);
  const ids = new SearchIds(st.db);
  for (const isReady of [true, false]) {
    ids.ready = isReady;
    expect(st.db.prepare(ids.matching("trace_id, span_id")).all({ match: "uniqueneedle" })).toEqual([]);
  }
  expect(st.collectRetentionIndex(1)).toBe(1);
  expect(st.db.prepare("SELECT COUNT(*) n FROM span_fts_ids").get()).toEqual({ n: 0 });
  expect(st.collectRetentionIndex(1)).toBe(0);
});

it("rolls back index tombstones with canonical deletion and preserves a reingested span", () => {
  const st = setup(); const { traceId, spanId } = send(st);
  const old = candidate(st, traceId);
  expect(() => st.db.transaction(() => { st.deleteRetentionCandidate(old); throw new Error("rollback"); }).immediate()).toThrow("rollback");
  expect(st.getRun(traceId)).toBeDefined();
  expect(st.db.prepare("SELECT COUNT(*) n FROM retention_pending_fts").get()).toEqual({ n: 0 });
  expect(st.deleteRetentionCandidate(candidate(st, traceId))).toBe("removed");
  send(st, traceId, spanId, "replacement");
  while (st.collectRetentionIndex(1)) { /* bounded deterministic fixture */ }
  expect(st.getOtlpSpan(traceId, spanId)).toBeDefined();
  expect(st.db.prepare("SELECT COUNT(*) n FROM span_fts").get()).toEqual({ n: 1 });
});

it("does not let a durable stale GC identity delete a reused rowid", () => {
  const st = setup(); const first = send(st);
  expect(st.deleteRetentionCandidate(candidate(st, first.traceId))).toBe("removed");
  const queued = st.db.prepare("SELECT id FROM retention_pending_fts").get() as { id: number };
  // Simulate another compatible writer physically removing the old index row before adding anew.
  st.db.prepare("DELETE FROM span_fts WHERE rowid = ?").run(BigInt(queued.id));
  st.db.prepare("DELETE FROM span_fts_ids WHERE id = ?").run(queued.id);
  const replacement = send(st);
  expect(st.db.prepare("SELECT id FROM span_fts_ids").get()).toEqual(queued);
  expect(st.db.prepare("SELECT COUNT(*) n FROM retention_pending_fts").get()).toEqual({ n: 0 });
  const reopened = new Store(st.dir);
  try {
    expect(reopened.collectRetentionIndex()).toBe(0);
    expect(reopened.getOtlpSpan(replacement.traceId, replacement.spanId)).toBeDefined();
    expect(reopened.db.prepare("SELECT COUNT(*) n FROM span_fts").get()).toEqual({ n: 1 });
  } finally { reopened.close(); }
});

it("preserves tombstones across mapping rebuild and drains them after reopening", async () => {
  const st = setup(); const first = send(st);
  expect(st.deleteRetentionCandidate(candidate(st, first.traceId))).toBe("removed");
  st.db.prepare("DELETE FROM span_fts_ids").run();
  const reopened = new Store(st.dir);
  try {
    await new Promise<void>((resolve, reject) => reopened.rebuildSearchIds((_n, ok) => ok ? resolve() : reject(new Error("rebuild failed"))));
    expect(reopened.db.prepare("SELECT COUNT(*) n FROM span_fts_ids").get()).toEqual({ n: 1 });
    expect(reopened.collectRetentionIndex(1)).toBe(1);
    expect(reopened.db.prepare("SELECT COUNT(*) n FROM span_fts_ids").get()).toEqual({ n: 0 });
  } finally { reopened.close(); }
});

it("fails safely when another supported connection starts rebuilding stale-ready mappings", async () => {
  const st = setup(); const first = send(st);
  st.db.prepare("DELETE FROM span_fts_ids").run();
  const other = new Store(st.dir);
  try {
    const rebuilding = new Promise<void>((resolve, reject) => other.rebuildSearchIds((_n, ok) => ok ? resolve() : reject(new Error("rebuild failed"))));
    expect(() => st.deleteRetentionCandidate(candidate(st, first.traceId))).toThrow("mappings rebuilding");
    expect(st.getRun(first.traceId)).toBeDefined();
    expect(st.db.prepare("SELECT COUNT(*) n FROM retention_pending_fts").get()).toEqual({ n: 0 });
    await rebuilding;
    st.refreshRetentionSearch();
    expect(st.deleteRetentionCandidate(candidate(st, first.traceId))).toBe("removed");
    expect(st.collectRetentionIndex()).toBe(1);
  } finally { other.close(); }
});

it("chooses the matching fallback at SQL execution after another connection starts rebuilding", async () => {
  const st = setup(); const first = send(st);
  const ids = new SearchIds(st.db);
  const sql = ids.matching("trace_id, span_id");
  const other = new Store(st.dir); const rebuildingIds = new SearchIds(other.db); rebuildingIds.ready = false;
  try {
    const rebuilding = new Promise<void>((resolve, reject) => rebuildingIds.rebuild((_n, ok) => ok ? resolve() : reject(new Error("rebuild failed"))));
    expect(st.db.prepare(sql).all({ match: "test" })).toEqual([{ trace_id: first.traceId, span_id: first.spanId }]);
    await rebuilding;
  } finally { other.close(); }
});

it("keeps scoped snippet selection in the snapshot used to choose its mapping path", async () => {
  const st = setup(); const first = send(st);
  const other = new Store(st.dir); const rebuildingIds = new SearchIds(other.db); rebuildingIds.ready = false;
  const prepare = st.db.prepare.bind(st.db);
  let rebuilding: Promise<void> | undefined;
  const spy = vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes("snippet(span_fts") && !rebuilding) {
      rebuilding = new Promise<void>((resolve, reject) => rebuildingIds.rebuild((_n, ok) => ok ? resolve() : reject(new Error("rebuild failed"))));
    }
    return prepare(sql);
  }) as typeof st.db.prepare);
  try {
    expect(st.searchSpans("test", 50, [first.traceId])).toHaveLength(1);
    expect(rebuilding).toBeDefined();
    spy.mockRestore();
    await rebuilding;
  } finally { spy.mockRestore(); other.close(); }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(schedulers.splice(0).map((value) => value.close()));
  closeTrackedStores();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

it("detects same-millisecond replacements, pin changes and delete/recreate ABA", () => {
  const st = setup(); const { traceId, spanId } = send(st);
  const first = candidate(st, traceId);
  send(st, traceId, spanId, "changed");
  expect(st.deleteRetentionCandidate(first)).toBe("changed");
  const second = candidate(st, traceId); st.setPinned(traceId, true); st.setPinned(traceId, false);
  expect(st.deleteRetentionCandidate(second)).toBe("changed");
  const third = candidate(st, traceId); st.deleteRun(traceId); send(st, traceId, spanId);
  expect(st.deleteRetentionCandidate(third)).toBe("changed");
  expect(st.getRun(traceId)).toBeDefined();
});

it("increments revisions for run-owned evidence changes even if timestamps stay equal", () => {
  const st = setup(); const { traceId } = send(st);
  const first = candidate(st, traceId);
  st.insertFinding({ trace_id: traceId, check_id: "c", check_kind: "rule", title: "finding", probability: null, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  expect(candidate(st, traceId).retention_revision).toBeGreaterThan(first.retention_revision);
  expect(st.deleteRetentionCandidate(first)).toBe("changed");
  const next = candidate(st, traceId);
  st.db.prepare("UPDATE runs SET updated_ms = updated_ms WHERE trace_id = ?").run(traceId);
  expect(st.deleteRetentionCandidate(next)).toBe("changed");
});

it("keeps owner guards, rechecks changes made by a guard, and reports actual deletes", () => {
  const st = setup(); const { traceId } = send(st); const planned = candidate(st, traceId);
  const after = vi.fn(() => { expect(st.db.inTransaction).toBe(false); }); st.afterDelete = after;
  st.deletionGuard = () => { throw new Error("audit hold"); };
  expect(st.deleteRetentionCandidate(planned)).toBe("held"); expect(after).not.toHaveBeenCalled();
  const changedGuard = vi.fn(() => st.setPinned(traceId, true)); st.deletionGuard = changedGuard;
  expect(st.deleteRetentionCandidate(planned)).toBe("changed"); expect(after).not.toHaveBeenCalled();
  expect(changedGuard).toHaveBeenCalledExactlyOnceWith(traceId);
  const allowedGuard = vi.fn(); st.deletionGuard = allowedGuard; st.setPinned(traceId, false);
  expect(st.deleteRetentionCandidate(candidate(st, traceId))).toBe("removed");
  expect(allowedGuard).toHaveBeenCalledExactlyOnceWith(traceId);
  expect(after).toHaveBeenCalledExactlyOnceWith([traceId]);
});

it("keeps direct public deletion guarded and propagates a current hold", () => {
  const st = setup(); const first = send(st);
  const guard = vi.fn(() => { throw new Error("current audit hold"); }); st.deletionGuard = guard;
  expect(() => st.deleteRun(first.traceId)).toThrow("current audit hold");
  expect(guard).toHaveBeenCalledExactlyOnceWith(first.traceId);
  expect(st.getRun(first.traceId)).toBeDefined();
});

it("backfills current rows atomically against a competing writer and tracks replacement/deletion", () => {
  const st = setup(); const { traceId, spanId } = send(st, undefined, undefined, "a".repeat(40_000));
  const rival = trackedStore(st.dir); rival.db.pragma("busy_timeout = 0");
  st.db.prepare("DELETE FROM retention_blob_refs").run();
  const prepare = st.db.prepare.bind(st.db); let checked = false;
  vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (sql.startsWith("SELECT rowid, trace_id")) {
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = all(...args);
        if (!checked) { checked = true; expect(() => send(rival, traceId, spanId, "b".repeat(40_000))).toThrow(/locked/); }
        return rows;
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof st.db.prepare);
  ready(st); expect(checked).toBe(true); vi.restoreAllMocks();
  send(rival, traceId, spanId, "b".repeat(40_000));
  const hashes = JSON.parse((st.db.prepare("SELECT blobs FROM spans").get() as { blobs: string }).blobs);
  expect(st.db.prepare("SELECT sha FROM retention_blob_refs").all()).toEqual([{ sha: hashes[0] }]);
  rival.deleteRun(traceId);
  expect(st.db.prepare("SELECT sha FROM retention_blob_refs").all()).toEqual([]);
  expect(backfillBlobReferences(st.db)).toBe(true);
  expect(st.db.prepare("SELECT sha FROM retention_blob_refs").all()).toEqual([]);
});

it("durably queues payloads and preserves current shared references and cleanup failures", () => {
  const st = setup(); const a = send(st, undefined, undefined, "shared".repeat(10_000));
  const b = send(st, undefined, undefined, "shared".repeat(10_000)); ready(st);
  const sha = (st.db.prepare("SELECT sha FROM retention_blob_refs LIMIT 1").get() as { sha: string }).sha;
  expect(st.deleteRetentionCandidate(candidate(st, a.traceId))).toBe("removed");
  expect(reclaimPendingBlobs(st.db, st.dir)).toBe(1); expect(st.blobs.get(sha)).toBeDefined();
  expect(st.deleteRetentionCandidate(candidate(st, b.traceId))).toBe("removed");
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw error; });
  expect(() => reclaimPendingBlobs(st.db, st.dir)).toThrow(error);
  expect(st.db.prepare("SELECT sha FROM retention_pending_blobs").all()).toEqual([{ sha }]);
  vi.restoreAllMocks(); expect(reclaimPendingBlobs(st.db, st.dir)).toBe(1); expect(st.blobs.get(sha)).toBeUndefined();
});

it("fails closed on legacy or newly malformed references, retaining pending protected bytes", () => {
  const st = setup(); const a = send(st, undefined, undefined, "shared".repeat(10_000));
  const b = send(st, undefined, undefined, "shared".repeat(10_000)); ready(st);
  const sha = (st.db.prepare("SELECT sha FROM retention_blob_refs LIMIT 1").get() as { sha: string }).sha;
  st.db.prepare("UPDATE spans SET blobs = 'broken' WHERE trace_id = ?").run(b.traceId);
  expect(st.deleteRetentionCandidate(candidate(st, a.traceId))).toBe("removed");
  expect(() => reclaimPendingBlobs(st.db, st.dir)).toThrow(/malformed/); expect(st.blobs.get(sha)).toBeDefined();
  st.db.prepare("DELETE FROM meta WHERE key LIKE 'retention_refs_%'").run();
  expect(() => backfillBlobReferences(st.db)).toThrow(); expect(st.blobs.get(sha)).toBeDefined();
});

it("runs one sweep through cleanup, yields between deletes and preserves held shared data", async () => {
  const st = setup(); const held = send(st, undefined, undefined, "shared".repeat(10_000));
  const shared = send(st, undefined, undefined, "shared".repeat(10_000));
  const old = send(st, undefined, undefined, "old".repeat(20_000));
  st.db.prepare("UPDATE runs SET ended_ms = 1, received_ms = 1").run();
  st.deletionGuard = (id) => { if (id === held.traceId) throw new Error("audit hold"); };
  const run = scheduler(st); let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try {
    const first = run.run(1, Infinity); expect(run.run(1, Infinity)).toBe(first);
    expect(await first).toBe(2);
  } finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0); expect(st.getRun(held.traceId)).toBeDefined();
  expect(st.getRun(shared.traceId)).toBeUndefined(); expect(st.getRun(old.traceId)).toBeUndefined();
  expect(st.batchesForTraces([held.traceId])[0].spans[0].attributes.find((attr) => attr.key === "payload")?.value).toEqual({ stringValue: "shared".repeat(10_000) });
  expect(st.db.prepare("SELECT * FROM retention_pending_blobs").all()).toEqual([]);
});

it("rejects an early worker exit, releases singleflight and retries safely", async () => {
  const st = setup(); send(st); const run = scheduler(st);
  const first = run.run(0, Infinity); const rejection = expect(first).rejects.toThrow(/worker exited/);
  const worker = (run as unknown as { worker: import("node:worker_threads").Worker }).worker;
  await worker.terminate(); await rejection;
  expect(await run.run(0, Infinity)).toBe(0);
});

it("closes during startup without touching the owner's closed database", async () => {
  const st = setup(); send(st); const run = scheduler(st);
  const first = run.run(1, Infinity); const rejection = first.catch(() => undefined);
  await run.close(); st.close(); await rejection;
  await expect(run.run(0, Infinity)).rejects.toThrow(/closed/);
});

it("moves reference and error mappings when span identity changes", () => {
  const st = setup(); const a = send(st, undefined, undefined, "a".repeat(40_000)); ready(st);
  const nextTrace = hex(16); const nextSpan = hex(8);
  st.db.prepare("UPDATE spans SET trace_id = ?, span_id = ? WHERE trace_id = ? AND span_id = ?").run(nextTrace, nextSpan, a.traceId, a.spanId);
  expect(st.db.prepare("SELECT trace_id, span_id FROM retention_blob_refs").all()).toEqual([{ trace_id: nextTrace, span_id: nextSpan }]);
  st.db.prepare("UPDATE spans SET blobs = 'broken'").run();
  st.db.prepare("UPDATE spans SET trace_id = ?, span_id = ?").run(a.traceId, a.spanId);
  expect(st.db.prepare("SELECT trace_id, span_id FROM retention_ref_errors").all()).toEqual([{ trace_id: a.traceId, span_id: a.spanId }]);
});
it("replans held shared payload weights and leaves unrelated non-run storage alone", async () => {
  const st = setup(); const held = send(st, undefined, undefined, "shared".repeat(10_000));
  const shared = send(st, undefined, undefined, "shared".repeat(10_000));
  const ids = [held.traceId, shared.traceId];
  for (let i = 0; i < 12; i++) ids.push(send(st, undefined, undefined, `${i}:` + "x".repeat(50_000)).traceId);
  ids.forEach((id, i) => st.db.prepare("UPDATE runs SET ended_ms = ?, received_ms = ? WHERE trace_id = ?").run(i + 1, i + 1, id));
  st.deletionGuard = (id) => { if (id === held.traceId) throw new Error("audit hold"); };
  const cap = st.storedBytes() * 0.7; const run = scheduler(st);
  expect(await run.run(0, cap)).toBeGreaterThan(0);
  expect(st.getRun(held.traceId)).toBeDefined();
  expect(st.batchesForTraces([held.traceId])[0].spans[0].attributes.find((attr) => attr.key === "payload")?.value).toEqual({ stringValue: "shared".repeat(10_000) });
  expect(await run.run(0, cap)).toBe(0);
  expect(st.db.prepare("SELECT * FROM retention_pending_blobs").all()).toEqual([]);
});

it("does not charge retention index pages or unrelated metadata to tiny runs", async () => {
  const st = setup(); const kept = send(st); const pinned = send(st, undefined, undefined, "protected".repeat(6_000));
  st.setPinned(pinned.traceId, true);
  st.db.prepare("INSERT INTO meta VALUES ('unrelated-large', ?)").run("m".repeat(500_000));
  const run = scheduler(st);
  expect(await run.run(0, 300_000)).toBe(0);
  expect(st.getRun(kept.traceId)).toBeDefined(); expect(st.getRun(pinned.traceId)).toBeDefined();
  expect(st.storedBytes()).toBeGreaterThan(300_000);
});

it("compacts derived deletion markers before replanning rather than evicting extra runs", async () => {
  const synchronous = setup(), scheduled = setup();
  const protectedRun = send(synchronous, undefined, undefined, "shared-protected".repeat(4_000));
  send(scheduled, protectedRun.traceId, protectedRun.spanId, "shared-protected".repeat(4_000));
  synchronous.setPinned(protectedRun.traceId, true); scheduled.setPinned(protectedRun.traceId, true);
  const ids: string[] = [];
  for (let i = 0; i < 80; i++) {
    const traceId = hex(16);
    ids.push(traceId);
    const rows = batch(Array.from({ length: 10 }, (_, j) => span({ traceId, name: `indexed-${i}-${j}`, kind: "tool",
      attrs: [s("neatlogs.tool.output", `${i}:${j}:` + "retained search words ".repeat(220))] })));
    synchronous.ingest([rows]); scheduled.ingest([rows]);
    for (const st of [synchronous, scheduled]) {
      st.db.prepare("UPDATE runs SET ended_ms = ?, received_ms = ? WHERE trace_id = ?").run(i + 1, i + 1, traceId);
    }
  }
  const cap = synchronous.storedBytes() * 0.5;
  const syncRemoved = synchronous.sweep(0, cap);
  expect(syncRemoved).toBeGreaterThan(0);
  const scheduledRemoved = await scheduler(scheduled).run(0, cap);
  expect(scheduledRemoved).toBeGreaterThan(0);
  expect(scheduledRemoved).toBeLessThanOrEqual(syncRemoved);
  const firstKept = ids.findIndex((id) => scheduled.getRun(id));
  expect(firstKept).toBeGreaterThan(0);
  expect(ids.slice(0, firstKept).every((id) => !scheduled.getRun(id))).toBe(true);
  expect(ids.slice(firstKept).every((id) => scheduled.getRun(id))).toBe(true);
  expect(scheduled.getOtlpSpan(protectedRun.traceId, protectedRun.spanId)).toBeDefined();
  expect(scheduled.blobs.size()).toBeGreaterThan(0);
  const beforeOptimize = scheduled.storedBytes();
  expect(beforeOptimize).toBeLessThanOrEqual(cap * 0.9 + 8 * 4096);
  expect(scheduled.db.prepare("SELECT COUNT(*) n FROM retention_pending_fts").get()).toEqual({ n: 0 });
  scheduled.db.prepare("INSERT INTO span_fts(span_fts) VALUES('optimize')").run();
  expect(beforeOptimize - scheduled.storedBytes()).toBeLessThanOrEqual(2 * 4096);
});

it.each([false, true])("activates run low-water trimming only when post-orphan bytes still exceed the cap (%s)", async (stillOver) => {
  const st = setup(); const healthy = send(st, undefined, undefined, "healthy payload ".repeat(120_000));
  const base = st.storedBytes();
  const cap = stillOver ? base * 0.75 : base / 0.95;
  st.db.prepare("INSERT INTO logs(body,received_ms) VALUES (?,1)").run("orphan ".repeat(150_000));
  expect(st.storedBytes()).toBeGreaterThan(cap);
  const removed = await scheduler(st).run(0, cap);
  expect(st.db.prepare("SELECT COUNT(*) n FROM logs").get()).toEqual({ n: 0 });
  if (stillOver) {
    expect(removed).toBe(1);
    expect(st.getRun(healthy.traceId)).toBeUndefined();
    expect(st.storedBytes()).toBeLessThanOrEqual(cap * 0.9);
  } else {
    expect(removed).toBe(0);
    expect(st.getRun(healthy.traceId)).toBeDefined();
    expect(st.storedBytes()).toBeGreaterThan(cap * 0.9);
    expect(st.storedBytes()).toBeLessThanOrEqual(cap);
  }
});

it("applies the secondary busy timeout before schema work and closes failed opens", () => {
  const st = setup(); send(st);
  const started = performance.now();
  st.db.transaction(() => {
    expect(() => new Store(st.dir, { busyTimeout: 0 })).toThrow(/locked/);
  }).immediate();
  expect(performance.now() - started).toBeLessThan(1_000);
  const secondary = new Store(st.dir, { busyTimeout: 0 }); secondary.close();
});
