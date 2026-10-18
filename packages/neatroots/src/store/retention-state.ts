import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export type RetentionCandidate = { trace_id: string; retention_revision: number };
const owned = ["spans", "logs", "findings", "decisions", "explanations", "notes", "summaries", "annotations"];
const valid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function blobHashes(value: string | null): string[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error("retention blocked: malformed blob references");
  return parsed;
}

/** Schema only: secondary connections never enumerate files or backfill references on open. */
export function installRetentionState(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "retention_revision")) db.exec("ALTER TABLE runs ADD COLUMN retention_revision INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_pending_fts (
      id INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retention_search_state (id INTEGER PRIMARY KEY, rebuilding INTEGER NOT NULL);
    INSERT OR IGNORE INTO retention_search_state VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS retention_blob_refs (
      sha TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
      PRIMARY KEY (sha, trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS retention_blob_refs_span ON retention_blob_refs(trace_id, span_id);
    CREATE TABLE IF NOT EXISTS retention_clock (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR IGNORE INTO retention_clock VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS retention_pending_blobs (sha TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_ref_errors (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, PRIMARY KEY(trace_id, span_id));
    CREATE TRIGGER IF NOT EXISTS retention_run_update AFTER UPDATE ON runs
    WHEN NEW.retention_revision = OLD.retention_revision
    BEGIN UPDATE retention_clock SET value = value + 1 WHERE id = 1;
      UPDATE runs SET retention_revision = (SELECT value FROM retention_clock WHERE id = 1) WHERE trace_id = NEW.trace_id; END;
    CREATE TRIGGER IF NOT EXISTS retention_run_insert AFTER INSERT ON runs BEGIN
      UPDATE retention_clock SET value = value + 1 WHERE id = 1;
      UPDATE runs SET retention_revision = (SELECT value FROM retention_clock WHERE id = 1) WHERE trace_id = NEW.trace_id; END;
  `);
  for (const table of owned) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const ids = event === "INSERT" ? "NEW.trace_id" : event === "DELETE" ? "OLD.trace_id" : "OLD.trace_id, NEW.trace_id";
      db.exec(`CREATE TRIGGER IF NOT EXISTS retention_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN UPDATE retention_clock SET value = value + 1 WHERE id = 1;
          UPDATE runs SET retention_revision = (SELECT value FROM retention_clock WHERE id = 1) WHERE trace_id IN (${ids}); END;`);
    }
  }
  // REPLACE need not fire DELETE triggers. INSERT therefore removes the previous span mapping too.
  for (const event of ["INSERT", "UPDATE"]) db.exec(`
    CREATE TRIGGER IF NOT EXISTS retention_refs_${event.toLowerCase()} AFTER ${event} ON spans BEGIN
      DELETE FROM retention_blob_refs WHERE (trace_id = NEW.trace_id AND span_id = NEW.span_id) ${event === "UPDATE" ? "OR (trace_id = OLD.trace_id AND span_id = OLD.span_id)" : ""};
      DELETE FROM retention_ref_errors WHERE (trace_id = NEW.trace_id AND span_id = NEW.span_id) ${event === "UPDATE" ? "OR (trace_id = OLD.trace_id AND span_id = OLD.span_id)" : ""};
      INSERT OR IGNORE INTO retention_ref_errors SELECT NEW.trace_id, NEW.span_id WHERE NEW.blobs IS NOT NULL AND
        CASE WHEN NOT json_valid(NEW.blobs) THEN 1 WHEN json_type(NEW.blobs) != 'array' THEN 1
          WHEN EXISTS (SELECT 1 FROM json_each(NEW.blobs) j WHERE typeof(j.value) != 'text' OR length(j.value) != 64 OR j.value GLOB '*[^0-9a-f]*') THEN 1 ELSE 0 END;
      INSERT OR IGNORE INTO retention_blob_refs SELECT j.value, NEW.trace_id, NEW.span_id
        FROM json_each(CASE WHEN json_valid(NEW.blobs) THEN NEW.blobs ELSE '[]' END) j
        WHERE typeof(j.value) = 'text' AND length(j.value) = 64 AND j.value NOT GLOB '*[^0-9a-f]*';
    END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS retention_refs_delete AFTER DELETE ON spans BEGIN
    DELETE FROM retention_blob_refs WHERE trace_id = OLD.trace_id AND span_id = OLD.span_id;
    DELETE FROM retention_ref_errors WHERE trace_id = OLD.trace_id AND span_id = OLD.span_id; END;`);
}

/** Backfill current rows under the writer lock; no stale SELECT result can be reinserted. */
export function backfillBlobReferences(db: Database.Database, limit = 128): boolean {
  return db.transaction(() => {
    if ((db.prepare("SELECT value FROM meta WHERE key = 'retention_refs_ready'").get() as { value: string } | undefined)?.value === "1") return true;
    const cursor = Number((db.prepare("SELECT value FROM meta WHERE key = 'retention_refs_cursor'").get() as { value: string } | undefined)?.value ?? 0);
    const rows = db.prepare("SELECT rowid, trace_id, span_id, blobs FROM spans WHERE rowid > ? ORDER BY rowid LIMIT ?")
      .all(cursor, limit) as { rowid: number; trace_id: string; span_id: string; blobs: string | null }[];
    const insert = db.prepare("INSERT OR IGNORE INTO retention_blob_refs VALUES (?, ?, ?)");
    for (const row of rows) {
      const hashes = blobHashes(row.blobs);
      db.prepare("DELETE FROM retention_blob_refs WHERE trace_id = ? AND span_id = ?").run(row.trace_id, row.span_id);
      for (const sha of hashes) insert.run(sha, row.trace_id, row.span_id);
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('retention_refs_cursor', ?)").run(String(rows.at(-1)?.rowid ?? cursor));
    if (rows.length < limit) db.prepare("INSERT OR REPLACE INTO meta VALUES ('retention_refs_ready', '1')").run();
    return rows.length < limit;
  }).immediate();
}

export function enqueueBlobReclamation(db: Database.Database, hashes: Iterable<string>): void {
  const add = db.prepare("INSERT OR IGNORE INTO retention_pending_blobs VALUES (?)");
  for (const sha of hashes) {
    if (!valid(sha)) throw new Error("retention blocked: malformed pending blob hash");
    add.run(sha);
  }
}

/** Owner only, with fresh indexed references and filesystem removal in one writer transaction. */
export function reclaimPendingBlobs(db: Database.Database, dir: string, limit = 16): number {
  return db.transaction(() => {
    const ready = (db.prepare("SELECT value FROM meta WHERE key = 'retention_refs_ready'").get() as { value: string } | undefined)?.value === "1";
    if (!ready) return 0;
    if (db.prepare("SELECT 1 FROM retention_ref_errors LIMIT 1").get()) throw new Error("retention blocked: malformed blob references");
    const rows = db.prepare("SELECT sha FROM retention_pending_blobs LIMIT ?").all(limit) as { sha: string }[];
    for (const { sha } of rows) {
      if (!valid(sha)) throw new Error("retention blocked: malformed pending blob hash");
      if (!db.prepare("SELECT 1 FROM retention_blob_refs WHERE sha = ? LIMIT 1").get(sha)) {
        try { fs.unlinkSync(path.join(dir, "blobs", sha.slice(0, 2), sha.slice(2))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      db.prepare("DELETE FROM retention_pending_blobs WHERE sha = ?").run(sha);
    }
    return rows.length;
  }).immediate();
}
