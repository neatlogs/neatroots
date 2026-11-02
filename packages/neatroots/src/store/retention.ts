import type Database from "better-sqlite3";
import type { BlobStore } from "./blobs.js";

/**
 * Retention works in steps (a generator that yields between them) so the same sweep can run in one
 * go, or a little at a time while the server keeps answering ingest, the app and MCP (#429).
 */
export type Steps<T> = Generator<void, T>;

/** Runs every step at once. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Runs the steps, giving the event loop a turn whenever `sliceMs` has passed since the last one.
 * Stops between steps, returning undefined, once `alive()` turns false (the store was closed).
 */
export async function runStepsAsync<T>(steps: Steps<T>, alive: () => boolean, sliceMs = 15): Promise<T | undefined> {
  let since = performance.now();
  for (;;) {
    if (!alive()) return undefined;
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - since >= sliceMs) {
      await new Promise((resolve) => setImmediate(resolve));
      since = performance.now();
    }
  }
}

/**
 * Merges the full-text index down to one segment, which releases the space deleted spans still
 * hold, a few pages at a time ('merge' with a page budget) instead of in one long 'optimize'.
 * A negative budget first gathers every segment into one merge; later calls continue it.
 */
export function* compactSearchIndex(db: Database.Database, pages = 64): Steps<void> {
  const segments = db.prepare("SELECT COUNT(DISTINCT segid) AS n FROM span_fts_idx");
  const changes = db.prepare("SELECT total_changes() AS n");
  const merge = db.prepare("INSERT INTO span_fts(span_fts, rank) VALUES('merge', ?)");
  const n = (stmt: Database.Statement) => (stmt.get() as { n: number }).n;
  let budget = -pages;
  for (let i = 0; i < 100_000 && n(segments) > 1; i++) {
    const before = n(changes);
    merge.run(budget);
    if (n(changes) - before < 2) break; // nothing left to merge
    budget = pages;
    yield;
  }
}

/**
 * Deletes the payload files among `candidates` that no span references any more, without one long
 * scan: spans are checked by `seq` range, `chunk` writes at a time, yielding between ranges. Every
 * span write (a new span or a re-sent one) takes the next seq, so the spans written while it scans
 * are exactly those after the seq it started at; they are checked, and the files deleted, in one
 * last step that nothing can interleave with. Returns how many files went.
 */
export function* reclaimPayloads(db: Database.Database, blobs: BlobStore, candidates: Iterable<string>, lastSeq: () => number, chunk = 5_000): Steps<number> {
  const shas = [...new Set(candidates)];
  if (!shas.length) return 0;
  const want = JSON.stringify(shas);
  const refs = db.prepare(
    `SELECT DISTINCT j.value AS sha FROM spans, json_each(CASE WHEN json_valid(spans.blobs) THEN spans.blobs ELSE '[]' END) AS j
     WHERE spans.seq > ? AND spans.seq <= ? AND spans.blobs IS NOT NULL AND j.value IN (SELECT value FROM json_each(?))`,
  );
  const used = new Set<string>();
  const start = lastSeq();
  for (let from = 0; from < start; from += chunk) {
    for (const r of refs.all(from, Math.min(from + chunk, start), want) as { sha: string }[]) used.add(r.sha);
    yield;
  }
  for (const r of refs.all(start, Number.MAX_SAFE_INTEGER, want) as { sha: string }[]) used.add(r.sha);
  let n = 0;
  for (const sha of shas) {
    if (used.has(sha)) continue;
    blobs.delete(sha);
    n++;
  }
  return n;
}

const ROW_BYTES = `octet_length(s.attributes) + octet_length(s.events) + octet_length(s.links) + IFNULL(octet_length(s.extra), 0) + IFNULL(octet_length(s.input_preview), 0) + IFNULL(octet_length(s.output_preview), 0) + octet_length(s.name)`;

/**
 * The oldest unpinned runs whose share of storedBytes() adds up to `excess`, sized `chunk` runs at a
 * time. A run's span rows are scaled to the database's share of `stored` (which also holds the
 * search index and table overhead). Blobs are shared between runs, so a blob counts only toward the
 * run whose deletion actually frees it: the newest run that references it, and never one a pinned run
 * still uses. Returns at least one run while any unpinned run exists.
 *
 * `indexByRun`: the search index's run ids are filled in (span_fts_ids), so a chunk's indexed text
 * is read by rowid; otherwise (the first start after an update) the whole index is read once.
 */
export function* oldestRunsCovering(db: Database.Database, blobs: BlobStore, indexByRun: boolean, excess: number, stored: number, chunk = 100): Steps<string[]> {
  const rows = (db.prepare("SELECT trace_id AS t, pinned FROM runs ORDER BY COALESCE(ended_ms, received_ms) ASC").all() as { t: string; pinned: number }[]).map((r) => ({ ...r, w: 0, b: null as string | null }));
  const at = new Map(rows.map((r, i) => [r.t, i]));
  const sized = db.prepare(`SELECT s.trace_id AS t, COALESCE(SUM(${ROW_BYTES}), 0) AS w, group_concat(s.blobs, '') AS b FROM spans s WHERE s.trace_id IN (SELECT value FROM json_each(?)) GROUP BY s.trace_id`);
  // A big value lives in a blob file but its text is also in the search index, so the indexed
  // text counts toward the run too.
  const indexed = db.prepare(`SELECT i.trace_id AS t, SUM(octet_length(f.name) + octet_length(f.tool_name) + octet_length(f.body)) AS f FROM span_fts_ids i JOIN span_fts f ON f.rowid = i.id WHERE i.trace_id IN (SELECT value FROM json_each(?)) GROUP BY i.trace_id`);
  for (let i = 0; i < rows.length; i += chunk) {
    const ids = JSON.stringify(rows.slice(i, i + chunk).map((r) => r.t));
    for (const r of sized.all(ids) as { t: string; w: number; b: string | null }[]) Object.assign(rows[at.get(r.t)!], { w: r.w, b: r.b });
    if (indexByRun) for (const r of indexed.all(ids) as { t: string; f: number | null }[]) rows[at.get(r.t)!].w += r.f ?? 0;
    yield;
  }
  if (!indexByRun) {
    // Read the whole index in rowid order, 1,000 rows at a time. FTS5 ignores a REAL rowid bound
    // (and better-sqlite3 binds JS numbers as REAL), so the bound is a BigInt.
    const scan = db.prepare("SELECT rowid AS id, trace_id AS t, octet_length(name) + octet_length(tool_name) + octet_length(body) AS f FROM span_fts WHERE rowid > ? ORDER BY rowid LIMIT 1000");
    scan.safeIntegers(true);
    for (let after = 0n; ; ) {
      const page = scan.all(after) as { id: bigint; t: string; f: bigint | null }[];
      for (const r of page) {
        const i = at.get(r.t);
        if (i !== undefined) rows[i].w += Number(r.f ?? 0n);
      }
      yield;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }
  const shas = rows.map((r) => (r.b ? [...new Set(r.b.match(/[0-9a-f]{64}/g) ?? [])] : []));
  const lastRef = new Map<string, number>();
  shas.forEach((list, i) => list.forEach((sha) => lastRef.set(sha, rows[i].pinned ? Infinity : Math.max(lastRef.get(sha) ?? -1, i))));
  const blobTotal = blobs.size();
  const rowTotal = rows.reduce((n, r) => n + r.w, 0);
  // Every table and index keeps at least its root page however many runs are deleted.
  const fixed = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE rootpage > 0").get() as { n: number }).n * (db.pragma("page_size", { simple: true }) as number);
  const rowScale = rowTotal > 0 ? Math.max(0, stored - blobTotal - fixed) / rowTotal : 0;
  const pick: string[] = [];
  let freed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].pinned) continue;
    pick.push(rows[i].t);
    freed += rows[i].w * rowScale;
    for (const sha of shas[i]) if (lastRef.get(sha) === i) freed += blobs.sizeOf(sha);
    if (freed >= excess) break;
  }
  return pick;
}
