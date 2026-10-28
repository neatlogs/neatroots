import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const home = () => {
  const h = tmpHome();
  homes.push(h);
  return h;
};

const words = (n: number) => Array.from({ length: n }, () => hex(4)).join(" ");
/** `runs` old runs of a few spans each, oldest first, with text that fills the search index. */
function fill(st: Store, runs: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) {
    const t = hex(16);
    ids.push(t);
    const root = hex(8);
    st.ingest([
      batch([
        span({ traceId: t, spanId: root, name: `run ${i}`, kind: "workflow", attrs: [s("input.value", words(300))] }),
        ...Array.from({ length: 4 }, () => span({ traceId: t, spanId: hex(8), parent: root, name: "step", kind: "tool", attrs: [s("input.value", words(300))] })),
      ]),
    ]);
    st.db.prepare("UPDATE runs SET received_ms = ?, ended_ms = ? WHERE trace_id = ?").run(1_000 + i, 1_000 + i, t);
  }
  return ids;
}
const exists = (st: Store, ids: string[]) => ids.map((t) => !!st.getRun(t));

// #429: a size trim ran in one synchronous pass (compact the search index, size every run, delete),
// so ingest, the app, MCP and /health all waited: about 10 s on a 1.1 GB store, 29 s on 2.2 GB.
describe("retention keeps the server answering", () => {
  it("sweepAsync trims exactly what sweep does, without blocking the event loop for long", async () => {
    const a = path.join(home(), "data");
    const st = trackedStore(a);
    const ids = fill(st, 160);
    st.setPinned(ids[0], true);
    st.db.pragma("wal_checkpoint(TRUNCATE)");
    st.close();
    const b = path.join(home(), "data");
    fs.cpSync(a, b, { recursive: true });
    const sync = trackedStore(a);
    const async = trackedStore(b);
    const cap = Math.floor(sync.storedBytes() * 0.5);

    const t0 = performance.now();
    const removed = sync.sweep(999_999, cap);
    const syncMs = performance.now() - t0;

    const lag = monitorEventLoopDelay({ resolution: 5 });
    lag.enable();
    const removedAsync = await async.sweepAsync(999_999, cap);
    lag.disable();
    const worstMs = lag.max / 1e6;

    expect(removed).toBeGreaterThan(0);
    expect(removedAsync).toBe(removed);
    expect(exists(async, ids)).toEqual(exists(sync, ids)); // the same runs went
    expect(async.getRun(ids[0])).toBeDefined(); // pinned survives
    expect(async.getRun(ids[1])).toBeUndefined(); // the oldest unpinned run went
    // The one-pass sweep blocks for its whole duration; the stepped one gives the loop a turn often.
    expect(worstMs, `worst stall ${worstMs.toFixed(0)} ms, one-pass sweep ${syncMs.toFixed(0)} ms`).toBeLessThan(Math.max(100, syncMs / 2));
  });

  it("keeps a run that takes new spans, or is pinned, while the sweep is working", async () => {
    const st = trackedStore(path.join(home(), "data"));
    const ids = fill(st, 40);
    const cap = Math.floor(st.storedBytes() * 0.3);
    let poked = false;
    const poke = setImmediate(function again() {
      if (poked) return;
      poked = true;
      st.ingest([batch([span({ traceId: ids[0], spanId: hex(8), name: "late step", kind: "tool" })])]); // the oldest run is still live
      st.setPinned(ids[1], true); // and someone pins the next one
    });
    const removed = await st.sweepAsync(999_999, cap, { sliceMs: 0 });
    clearImmediate(poke);
    expect(poked).toBe(true);
    expect(removed).toBeGreaterThan(0);
    expect(st.getRun(ids[0])).toBeDefined();
    expect(st.getRun(ids[1])).toBeDefined();
    expect(st.getRun(ids[2])).toBeUndefined(); // the next oldest went as usual
  });
});

// Review on #674: payloads used to be reclaimed only at the end of the sweep, so after an age sweep
// removed runs with big payloads, the size check still counted those files and trimmed more runs.
it("frees an age sweep's payloads before measuring for the size cap", () => {
  const st = trackedStore(path.join(home(), "data"));
  const recent: string[] = [];
  for (let i = 0; i < 20; i++) {
    const t = hex(16);
    recent.push(t);
    st.ingest([batch([span({ traceId: t, spanId: hex(8), name: `recent ${i}`, kind: "workflow", attrs: [s("input.value", words(200))] })])]);
  }
  const recentBytes = st.storedBytes(); // no payload files yet
  const aged = Date.now() - 60 * 86_400_000;
  for (let i = 0; i < 10; i++) {
    const t = hex(16);
    st.ingest([batch([span({ traceId: t, spanId: hex(8), name: `old ${i}`, kind: "workflow", attrs: [s("input.value", words(20_000))] })])]); // over the blob threshold
    st.db.prepare("UPDATE runs SET received_ms = ?, ended_ms = ? WHERE trace_id = ?").run(aged, aged, t);
  }
  // Over the cap while the old runs' files are still counted, under it once they're gone.
  const removed = st.sweep(14, Math.floor(recentBytes + st.blobs.size() / 2));
  expect(removed).toBe(10); // the 10 old runs, and no recent one to make room for files already gone
  expect(recent.every((t) => st.getRun(t))).toBe(true);
});

// Review on #674 (CodeRabbit): reclaiming payloads scanned every span in one go. It now scans in
// seq ranges between turns of the event loop; a span written meanwhile must still keep its file.
it("keeps a payload that a span written during the reference scan uses", async () => {
  const { reclaimPayloads } = await import("../src/store/retention.js");
  const st = trackedStore(path.join(home(), "data"));
  const big = words(20_000); // over the blob threshold
  const t = hex(16);
  st.ingest([batch([span({ traceId: t, spanId: hex(8), name: "old", kind: "workflow", attrs: [s("input.value", big)] })])]);
  for (let i = 0; i < 30; i++) st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: `filler ${i}`, kind: "workflow" })])]);
  const sha = (st.db.prepare("SELECT j.value AS sha FROM spans, json_each(spans.blobs) AS j WHERE trace_id = ?").get(t) as { sha: string }).sha;
  st.deleteRun(t); // its file goes with it
  const file = st.blobs.files().find((f) => f.sha === sha);
  expect(file).toBeUndefined();
  // Put it back unreferenced, then reclaim it while another span starts using it partway through.
  st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: "first", kind: "workflow", attrs: [s("input.value", big)] })])]);
  st.db.prepare("DELETE FROM spans WHERE name = 'first'").run(); // a reference gone, file still there
  const lastSeq = () => (st.db.prepare("SELECT MAX(seq) AS s FROM spans").get() as { s: number }).s;
  const steps = reclaimPayloads(st.db, st.blobs, [sha], lastSeq, 5);
  steps.next(); // the first seq range is checked
  st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: "second", kind: "workflow", attrs: [s("input.value", big)] })])]);
  let r = steps.next();
  while (!r.done) r = steps.next();
  expect(r.value).toBe(0);
  expect(st.blobs.files().some((f) => f.sha === sha)).toBe(true);
});

it("deletes in one go while the search index's run ids aren't filled in", async () => {
  const st = trackedStore(path.join(home(), "data"));
  fill(st, 30);
  (st as unknown as { searchIds: { ready: boolean } }).searchIds.ready = false;
  const cap = Math.floor(st.storedBytes() * 0.5);
  let scans = 0;
  const orig = st.db.prepare.bind(st.db);
  st.db.prepare = ((sql: string) => {
    if (/^DELETE FROM span_fts WHERE trace_id/.test(sql)) scans++;
    return orig(sql);
  }) as typeof st.db.prepare;
  const removed = await st.sweepAsync(999_999, cap, { sliceMs: 0 });
  st.db.prepare = orig;
  expect(removed).toBeGreaterThan(4);
  expect(scans).toBe(1); // was one full index scan per 4 runs
});

// Review on #674 (CodeRabbit): before the search index's run ids are filled in (the first start after
// an update), a trim can only delete and size runs by scanning the whole index in one go. The server
// waits for the rebuild instead, and sweeps as soon as it has finished.
it("waits for the search index's run ids, then sweeps as soon as they're filled in", async () => {
  const { makeRoots } = await import("./helpers.js");
  const t = await makeRoots({ noEngine: true, config: (c) => (c.retention.days = 14) });
  try {
    const old: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = hex(16);
      old.push(id);
      t.roots.ingest([batch([span({ traceId: id, spanId: hex(8), name: `old ${i}`, kind: "workflow" })])]);
    }
    const aged = Date.now() - 60 * 86_400_000;
    t.roots.store.db.prepare("UPDATE runs SET received_ms = ?, ended_ms = ?").run(aged, aged);
    await new Promise((r) => setTimeout(r, 30)); // the startup rebuild reports in first (already ready here)
    const internals = t.roots as unknown as { searchSettled: boolean; searchIdsSettled(): void; sweeping?: Promise<void> };
    (t.roots.store as unknown as { searchIds: { ready: boolean } }).searchIds.ready = false;
    internals.searchSettled = false;
    t.roots.startRetention();
    await new Promise((r) => setTimeout(r, 30));
    expect(old.every((id) => t.roots.store.getRun(id))).toBe(true); // nothing trimmed yet
    (t.roots.store as unknown as { searchIds: { ready: boolean } }).searchIds.ready = true;
    internals.searchIdsSettled();
    await internals.sweeping;
    expect(old.some((id) => t.roots.store.getRun(id))).toBe(false); // the waiting sweep ran
  } finally {
    await t.close();
  }
});
