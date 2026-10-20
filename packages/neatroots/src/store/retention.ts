import type Database from "better-sqlite3";
import { log } from "../util/log.js";

const LOG_BATCH = 256;
const ORPHAN = "(trace_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = logs.trace_id))";

/** Keyset pagination bounds each batch, even when a selected log acquires an owner before DELETE. */
export function trimOrphanLogs(db: Database.Database, options: { cutoff?: number; excess?: () => number }): number {
  let removed = 0;
  let cursor: { received_ms: number; id: number } | undefined;
  while (options.excess === undefined || options.excess() > 0) {
    const rows = db.prepare(
      `SELECT id, received_ms, octet_length(COALESCE(body, '')) + octet_length(COALESCE(attributes, '')) AS bytes
       FROM logs INDEXED BY logs_received WHERE ${ORPHAN}
       ${options.cutoff === undefined ? "" : "AND received_ms < @cutoff"}
       ${cursor ? "AND (received_ms, id) > (@received_ms, @id)" : ""}
       ORDER BY received_ms, id LIMIT ${LOG_BATCH}`,
    ).all({ ...(cursor ?? {}), ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }) }) as { id: number; received_ms: number; bytes: number }[];
    if (!rows.length) break;
    const picked: number[] = [];
    let estimate = 0;
    const excess = options.excess?.() ?? Infinity;
    for (const row of rows) {
      picked.push(row.id);
      cursor = row;
      estimate += Math.max(row.bytes, 1);
      if (estimate >= excess) break;
    }
    // A different SQLite connection can ingest the run between selection and deletion.
    // Recheck at the write, and advance past newly protected rows even if no row was deleted.
    removed += db.prepare(`DELETE FROM logs WHERE id IN (SELECT value FROM json_each(?)) AND ${ORPHAN}`)
      .run(JSON.stringify(picked)).changes;
  }
  return removed;
}

/**
 * Attribute only pages of run-owned tables to their rows, not the whole database to spans.
 * Shared table/index pages are apportioned by row content; unrelated/orphan rows keep their share.
 * Root pages cannot be freed and are excluded. Resources, sessions, config and metadata persist
 * independently of run deletion, so none of their pages belong in a run's eviction estimate.
 */
export function runDatabaseWeights(db: Database.Database): Map<string, number> | undefined {
  const weights = new Map<string, number>();
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  let pages: { name: string; bytes: number }[];
  try {
    pages = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all() as typeof pages;
  } catch (error) {
    if (!/no such table: (?:main\.)?dbstat/i.test(String(error))) throw error;
    // Some custom SQLite builds omit this optional module. Preserve runs rather than reverting
    // to whole-database attribution; age/orphan retention and actual byte reporting still work.
    log.warn("run size eviction skipped: SQLite dbstat is unavailable; age and orphan-log retention remain active");
    return undefined;
  }
  const schema = db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE rootpage > 0").all() as { name: string; tbl_name: string }[];
  const owner = new Map(schema.map((row) => [row.name, row.tbl_name]));
  const bytes = new Map<string, number>();
  for (const row of pages) {
    const table = owner.get(row.name) ?? row.name;
    bytes.set(table, (bytes.get(table) ?? 0) + Math.max(0, row.bytes - pageSize));
  }
  for (const table of ["runs", "spans", "logs", "findings", "decisions", "explanations", "notes", "summaries", "annotations", "span_fts_ids", "span_fts"]) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    // Column names come from our own schema. Include a small record/header allowance per column.
    const content = columns.map((c) => `COALESCE(octet_length(CAST("${c}" AS BLOB)), 0) + 2`).join(" + ");
    const rows = db.prepare(`SELECT trace_id, SUM(${content}) AS weight FROM ${table} GROUP BY trace_id`).all() as { trace_id: string | null; weight: number }[];
    let held = bytes.get(table) ?? 0;
    if (table === "span_fts") {
      held = [...bytes].reduce((n, [name, value]) => n + (name.startsWith("span_fts_") && name !== "span_fts_ids" ? value : 0), held);
    }
    const total = rows.reduce((n, row) => n + row.weight, 0);
    if (!total || !held) continue;
    for (const row of rows) {
      if (row.trace_id !== null) weights.set(row.trace_id, (weights.get(row.trace_id) ?? 0) + held * row.weight / total);
    }
  }
  return weights;
}
