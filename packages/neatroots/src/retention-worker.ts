import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./store/db.js";
import { backfillBlobReferences, type RetentionCandidate } from "./store/retention-state.js";

type Cursor = { received_ms: number; id: number };
const ORPHAN = "(trace_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = logs.trace_id))";
const store = new Store((workerData as { dir: string }).dir, { busyTimeout: 50 });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
let blobBytes: number | undefined;

function pendingBytes(): number {
  return (store.db.prepare(`SELECT p.sha FROM retention_pending_blobs p WHERE NOT EXISTS
    (SELECT 1 FROM retention_blob_refs r WHERE r.sha = p.sha)`).all() as { sha: string }[])
    .reduce((sum, row) => sum + store.blobs.sizeOf(row.sha), 0);
}
function databaseBytes(): number {
  return ((store.db.pragma("page_count", { simple: true }) as number) - (store.db.pragma("freelist_count", { simple: true }) as number)) * (store.db.pragma("page_size", { simple: true }) as number);
}
async function initialize(progress: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => store.rebuildSearchIds((_n, ready) => ready ? resolve() : reject(new Error("retention search mappings unavailable")), progress));
  const deadline = Date.now() + 60_000;
  while (!backfillBlobReferences(store.db)) {
    if (Date.now() > deadline) throw new Error("retention reference backfill paused at its durable cursor");
    progress();
    await pause();
  }
  if (store.db.prepare("SELECT 1 FROM retention_ref_errors LIMIT 1").get()) throw new Error("retention blocked: malformed blob references");
}
async function compact(progress: () => void): Promise<boolean> {
  const segments = () => (store.db.prepare("SELECT COUNT(DISTINCT segid) AS n FROM span_fts_idx").get() as { n: number }).n;
  const changes = () => (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const merge = store.db.prepare("INSERT INTO span_fts(span_fts, rank) VALUES('merge', ?)");
  const deadline = Date.now() + 60_000;
  let budget = -16;
  while (segments() > 1 && Date.now() < deadline) {
    const before = changes();
    try { merge.run(budget); }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
      await pause(); continue;
    }
    if (changes() - before < 2) return true;
    budget = 16;
    progress();
    await pause();
  }
  return segments() <= 1;
}
function logs(options: { cutoff?: number; maxBytes?: number; cursor?: Cursor }) {
  blobBytes ??= store.blobs.size() - pendingBytes();
  const excess = options.maxBytes === undefined ? Infinity : databaseBytes() + blobBytes - options.maxBytes * 0.9;
  if (excess <= 0) return { ids: [], cursor: options.cursor };
  const rows = store.db.prepare(`SELECT id, received_ms, octet_length(COALESCE(body,'')) + octet_length(COALESCE(attributes,'')) AS bytes
    FROM logs INDEXED BY logs_received WHERE ${ORPHAN}
    ${options.cutoff === undefined ? "" : "AND received_ms < @cutoff"}
    ${options.cursor ? "AND (received_ms,id) > (@received_ms,@id)" : ""}
    ORDER BY received_ms,id LIMIT 256`).all({ ...(options.cursor ?? {}), ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }) }) as (Cursor & { bytes: number })[];
  const ids: number[] = []; let estimate = 0; let cursor = options.cursor;
  for (const row of rows) { ids.push(row.id); cursor = { id: row.id, received_ms: row.received_ms }; estimate += Math.max(1, row.bytes); if (estimate >= excess) break; }
  return { ids, cursor };
}
async function handle(type: string, args: any, progress: () => void): Promise<unknown> {
  if (type === "initialize") { await initialize(progress); return null; }
  if (type === "collectIndex") {
    const deadline = Date.now() + 60_000;
    let collected = false;
    while (store.collectRetentionIndex()) {
      collected = true;
      if (Date.now() > deadline) throw new Error("retention index cleanup paused with durable pending rows");
      progress();
      await pause();
    }
    // FTS deletions themselves create index markers. Reclaim those before another cap plan,
    // otherwise successive batches could charge obsolete derived pages to unrelated live runs.
    if (collected && !await compact(progress)) throw new Error("retention index compaction paused; run eviction deferred");
    return null;
  }
  if (type === "age") return store.db.prepare(`SELECT trace_id, retention_revision FROM runs WHERE pinned = 0
    AND COALESCE(ended_ms, received_ms) < ? AND trace_id NOT IN (SELECT value FROM json_each(?))
    ORDER BY COALESCE(ended_ms,received_ms), trace_id LIMIT 32`).all(args.cutoff, JSON.stringify(args.protectedIds)) as RetentionCandidate[];
  if (type === "logs") return logs(args);
  if (type === "sizeStart") {
    blobBytes = undefined;
    if (store.storedBytes() - pendingBytes() <= args.maxBytes) return { over: false, compacted: true };
    const compacted = await compact(progress);
    return { over: store.storedBytes() - pendingBytes() > args.maxBytes, compacted };
  }
  if (type === "sizeCheck") return store.storedBytes() - pendingBytes();
  if (type === "size") {
    const size = store.storedBytes() - pendingBytes();
    const candidates = size > args.targetBytes ? store.planRetentionRuns(args.maxBytes, args.protectedIds, args.targetBytes) : [];
    return { size, candidates };
  }
  if (type === "finish") { store.db.pragma("wal_checkpoint(PASSIVE)"); store.close(); setImmediate(() => parentPort!.close()); return null; }
  throw new Error(`unknown retention operation: ${type}`);
}
let queue = Promise.resolve();
parentPort!.on("message", (message: { id: number; type: string; args: unknown }) => {
  queue = queue.then(async () => {
    try { parentPort!.postMessage({ id: message.id, value: await handle(message.type, message.args, () => parentPort!.postMessage({ id: message.id, progress: true })) }); }
    catch (error) { parentPort!.postMessage({ id: message.id, error: (error as Error).message }); }
  });
});
