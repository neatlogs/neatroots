import type Database from "better-sqlite3";

/**
 * Logs that no run will ever delete: sent without a trace id (startup logs, background jobs), or
 * with a trace id whose run never arrived. Deleting runs removes only logs with a run, so retention
 * deletes these on their own (#267). A log can arrive before its run's spans, so one with a trace
 * id counts as having no run only after LOG_GRACE_MS.
 */
export const LOG_GRACE_MS = 3_600_000;

const UNATTACHED = `(logs.trace_id IS NULL OR (logs.received_ms < @grace AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = logs.trace_id)))`;
const ROW_BYTES = "IFNULL(octet_length(body), 0) + IFNULL(octet_length(attributes), 0) + IFNULL(octet_length(time_ns), 0) + 64";
/** Rows deleted per statement, so a large backlog doesn't hold one long write. */
const BATCH = 5_000;

const deleteIds = (db: Database.Database, ids: number[]) => db.prepare("DELETE FROM logs WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids)).changes;

/**
 * Deletes logs with no run received before `cutoffMs`, oldest first, in batches. Each batch starts
 * where the last one stopped, so old logs that belong to a kept run are read once, not per batch.
 * Returns how many went.
 */
export function deleteUnattachedLogsBefore(db: Database.Database, cutoffMs: number, now = Date.now()): number {
  const pick = db.prepare(
    `SELECT id, received_ms AS ms FROM logs WHERE received_ms < @cutoff AND (received_ms > @ms OR (received_ms = @ms AND id > @id)) AND ${UNATTACHED} ORDER BY received_ms, id LIMIT ${BATCH}`,
  );
  let total = 0;
  let after = { ms: -1, id: -1 };
  for (;;) {
    const rows = pick.all({ cutoff: cutoffMs, grace: now - LOG_GRACE_MS, ...after }) as { id: number; ms: number }[];
    if (!rows.length) return total;
    total += deleteIds(db, rows.map((r) => r.id));
    if (rows.length < BATCH) return total;
    after = { ms: rows[rows.length - 1].ms, id: rows[rows.length - 1].id };
  }
}

/** Deletes the oldest logs with no run whose rows add up to about `bytes`. Returns how many went. */
export function trimUnattachedLogs(db: Database.Database, bytes: number, now = Date.now()): number {
  // Rows are read lazily, oldest first, and only until enough are picked.
  const ids: number[] = [];
  let freed = 0;
  for (const r of db.prepare(`SELECT id, ${ROW_BYTES} AS w FROM logs WHERE ${UNATTACHED} ORDER BY received_ms, id`).iterate({ grace: now - LOG_GRACE_MS }) as Iterable<{ id: number; w: number }>) {
    if (freed >= bytes) break;
    ids.push(r.id);
    freed += r.w;
  }
  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) total += deleteIds(db, ids.slice(i, i + BATCH));
  return total;
}
