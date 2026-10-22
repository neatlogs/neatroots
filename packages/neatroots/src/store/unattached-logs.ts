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

/** Deletes logs with no run received before `cutoffMs`. Returns how many went. */
export function deleteUnattachedLogsBefore(db: Database.Database, cutoffMs: number, now = Date.now()): number {
  return db.prepare(`DELETE FROM logs WHERE received_ms < @cutoff AND ${UNATTACHED}`).run({ cutoff: cutoffMs, grace: now - LOG_GRACE_MS }).changes;
}

/** Deletes the oldest logs with no run whose rows add up to about `bytes`. Returns how many went. */
export function trimUnattachedLogs(db: Database.Database, bytes: number, now = Date.now()): number {
  const rows = db.prepare(`SELECT id, ${ROW_BYTES} AS w FROM logs WHERE ${UNATTACHED} ORDER BY received_ms, id`).all({ grace: now - LOG_GRACE_MS }) as { id: number; w: number }[];
  const ids: number[] = [];
  let freed = 0;
  for (const r of rows) {
    if (freed >= bytes) break;
    ids.push(r.id);
    freed += r.w;
  }
  if (!ids.length) return 0;
  return db.prepare("DELETE FROM logs WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids)).changes;
}
