import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../store/db.js";

/** Read a consistent provenance/enablement snapshot without Store migrations or live data writes.
 * SQLite may update its transient WAL coordination sidecars. It owns WAL recovery/reader semantics;
 * errors reported by SQLite fail closed, but this is not a separate damaged-WAL integrity checker.
 */
export function copyOfflineApprovalState(home: string, target: Store): void {
  const dir = path.join(home, "data"), source = Store.dbFile(dir);
  let db: Database.Database | undefined;
  try {
    try { fs.statSync(source); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      for (const name of ["neatroots.db", "bolts.db"]) for (const suffix of ["-wal", "-shm", "-journal"]) {
        try { fs.statSync(path.join(dir, `${name}${suffix}`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        throw new Error("orphan approval state sidecar");
      }
      return; // A fresh CI home needs no persistent state or directories.
    }
    db = new Database(source, { readonly: true, fileMustExist: true });
    const state = db.transaction(() => ({
      meta: db!.prepare("SELECT key, value FROM meta WHERE key GLOB 'mcp_origin:*' OR key GLOB 'approved_mcp:*'").all() as { key: string; value: string }[],
      // Planner fallback bodies must never introduce ambient checks into repository-only runs.
      rows: db!.prepare("SELECT id, kind, source, path, body, enabled FROM checks WHERE path IS NOT NULL AND source != 'planner'").all() as { id: string; kind: string; source: string; path: string; body: string; enabled: number }[],
    }))();
    target.db.transaction(() => {
      for (const m of state.meta) target.setMeta(m.key, m.value);
      for (const row of state.rows) target.upsertCheckRow({ ...row, enabled: row.enabled !== 0 });
    })();
  } catch (e) { throw new Error(`cannot read offline approval state: ${(e as Error).message}`); }
  finally { db?.close(); }
}