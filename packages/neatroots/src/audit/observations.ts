import fs from "node:fs";
import path from "node:path";
import type { Store } from "../store/db.js";
import type { Verification } from "./manifest.js";

const stores = new WeakMap<Store, ArchiveObservations>();
const FAILURE = "archive could not be written or verified; inspect the local archive directory and permissions";

/** Two metadata stats only; never walk, read, hash or authorize archive contents here. */
function stamp(directory: string): string | null {
  try {
    return [directory, path.join(directory, "manifest.jsonl")].map(p => {
      const s = fs.lstatSync(p);
      return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(":");
    }).join("|");
  } catch { return null; }
}

/** Local observations are hints for status, never deletion receipts. Cold starts are unknown. */
class ArchiveObservations {
  private last?: { directory: string; at: number; ok: boolean; stamp: string | null;
    seq: number; head: string | null; entries: number; runs: number; bytes: number; totalsKnown: boolean };
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TEMP TABLE audit_status_versions(trace_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TEMP TABLE audit_status_snapshots(trace_id TEXT PRIMARY KEY, version INTEGER NOT NULL, directory TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TEMP TABLE audit_status_errors(trace_id TEXT PRIMARY KEY);`);
    // Revisions catch direct local SQL edits too, without serializing evidence on status reads.
    for (const table of ["runs", "spans", "findings", "decisions", "explanations", "summaries", "annotations", "check_progress"]) {
      if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        if (table === "runs" && operation === "DELETE") continue;
        const row = operation === "DELETE" ? "OLD" : "NEW";
        store.db.exec(`CREATE TEMP TRIGGER audit_status_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN
          INSERT INTO audit_status_versions VALUES (${row}.trace_id,1) ON CONFLICT(trace_id) DO UPDATE SET version=version+1;
        END;`);
      }
    }
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      store.db.exec(`CREATE TEMP TRIGGER audit_status_meta_${operation} AFTER ${operation} ON main.meta
        WHEN substr(${row}.key,1,14)='import-source:' BEGIN
        INSERT INTO audit_status_versions VALUES (substr(${row}.key,15),1)
          ON CONFLICT(trace_id) DO UPDATE SET version=version+1;
      END;`);
    }
    store.db.exec(`CREATE TEMP TRIGGER audit_status_deleted AFTER DELETE ON main.runs BEGIN
      DELETE FROM audit_status_snapshots WHERE trace_id=OLD.trace_id;
      DELETE FROM audit_status_errors WHERE trace_id=OLD.trace_id;
      DELETE FROM audit_status_versions WHERE trace_id=OLD.trace_id;
    END;`);
  }

  verified(directory: string, report: Verification): void {
    const normalized = path.resolve(directory);
    const prior = this.last?.directory === normalized ? this.last : undefined;
    this.last = { directory: normalized, at: Date.now(), ok: report.ok, stamp: stamp(normalized),
      seq: report.ok ? report.seq : prior?.seq ?? 0, head: report.ok ? report.head : prior?.head ?? null,
      entries: report.ok ? report.entries.length : prior?.entries ?? 0,
      runs: report.ok ? new Set(report.entries.map(e => e.trace_id)).size : prior?.runs ?? 0,
      bytes: report.ok ? report.archive_bytes : prior?.bytes ?? 0, totalsKnown: report.ok || !!prior?.totalsKnown };
  }
  failed(directory: string): void {
    this.verified(directory, { ok: false, entries: [], seq: 0, head: "", errors: [], archive_bytes: 0 });
  }
  snapshot(id: string, directory: string, bytes: number): void {
    this.store.db.prepare(`INSERT INTO audit_status_snapshots VALUES (?,COALESCE((SELECT version FROM audit_status_versions WHERE trace_id=?),0),?,?)
      ON CONFLICT(trace_id) DO UPDATE SET version=excluded.version,directory=excluded.directory,bytes=excluded.bytes`).run(id, id, path.resolve(directory), bytes);
    this.store.db.prepare("DELETE FROM audit_status_errors WHERE trace_id=?").run(id);
  }
  clearError(id: string): void { this.store.db.prepare("DELETE FROM audit_status_errors WHERE trace_id=?").run(id); }
  error(id: string): void { this.store.db.prepare("INSERT OR IGNORE INTO audit_status_errors VALUES (?)").run(id); }

  status(directory: string, projects: string[], namedUnknown: string[], engine: boolean, pending: string[]) {
    const normalized = path.resolve(directory);
    const last = this.last?.directory === normalized ? this.last : undefined;
    const sameFiles = !!last?.ok && last.stamp !== null && stamp(normalized) === last.stamp;
    const progress = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='check_progress'").get()
      ? "EXISTS (SELECT 1 FROM check_progress p WHERE p.trace_id=r.trace_id)" : "0";
    const query = `WITH sizes AS (SELECT trace_id,SUM(octet_length(attributes)+octet_length(events)+octet_length(links)+COALESCE(octet_length(extra),0)) AS bytes FROM spans GROUP BY trace_id),
      covered AS (SELECT r.trace_id, COALESCE(CASE WHEN o.version=COALESCE(v.version,0) THEN o.bytes END,s.bytes,0) AS bytes,
        CASE WHEN NOT (r.complete OR r.root_ended) THEN 'run has not ended'
          WHEN NOT ? THEN 'check engine unavailable' WHEN (${progress} OR r.trace_id IN (SELECT value FROM json_each(?))) THEN 'checks are pending or interrupted'
          WHEN e.trace_id IS NOT NULL THEN '${FAILURE}' WHEN NOT ? THEN 'archive observation unavailable or stale'
          WHEN o.trace_id IS NULL THEN 'current snapshot not observed'
          WHEN o.version<>COALESCE(v.version,0) THEN 'current snapshot changed' END AS reason,
        (o.trace_id IS NULL OR o.version<>COALESCE(v.version,0)) AS stale, e.trace_id IS NOT NULL AS has_error
      FROM runs r LEFT JOIN sizes s ON s.trace_id=r.trace_id LEFT JOIN audit_status_versions v ON v.trace_id=r.trace_id
      LEFT JOIN audit_status_snapshots o ON o.trace_id=r.trace_id AND o.directory=? LEFT JOIN audit_status_errors e ON e.trace_id=r.trace_id
      WHERE r.doctor=0 AND r.project IN (SELECT value FROM json_each(?))
        AND (r.project<>'unknown' OR r.trace_id IN (SELECT value FROM json_each(?))))`;
    const args = [Number(engine), JSON.stringify(pending), Number(sameFiles), normalized, JSON.stringify(projects), JSON.stringify(namedUnknown)];
    const rows = this.store.db.prepare(query + " SELECT reason,COUNT(*) AS n,SUM(bytes) AS bytes,SUM(stale) AS stale FROM covered GROUP BY reason").all(...args) as { reason: string | null; n: number; bytes: number; stale: number }[];
    let covered = 0, held = 0, archived = 0, heldBytes = 0, archivedBytes = 0, stale = 0;
    const reasons: Record<string, number> = {};
    for (const row of rows) {
      covered += row.n; stale += row.stale;
      if (row.reason) { held += row.n; heldBytes += row.bytes; reasons[row.reason] = row.n; }
      else { archived += row.n; archivedBytes += row.bytes; }
    }
    const failures = this.store.db.prepare(query + ` SELECT trace_id FROM covered WHERE has_error LIMIT 100`).all(...args) as { trace_id: string }[];
    const pages = this.store.db.pragma("page_count", { simple: true }) as number;
    const free = this.store.db.pragma("freelist_count", { simple: true }) as number;
    const pageSize = this.store.db.pragma("page_size", { simple: true }) as number;
    return { covered_runs: covered, held_runs: held, held_bytes: heldBytes, archived_live_runs: archived, archived_live_bytes: archivedBytes,
      archived_runs: last?.runs ?? 0, archive_entries: last?.entries ?? 0, archive_bytes: last?.bytes ?? 0,
      live_store_bytes: (pages-free)*pageSize, live_store_bytes_kind: "sqlite_pages_only" as const,
      byte_estimate: "last_observed_snapshot_or_inline_metadata" as const,
      seq: last?.seq ?? 0, head: last?.head ?? null, verified: null,
      observation_state: !last ? "unknown" : !last.ok ? "error" : !sameFiles || stale ? "stale" : "current",
      observed_ms: last?.at ?? null, last_observed_verified: last?.ok ?? null, archive_totals_known: !!last?.totalsKnown,
      integrity: "not_rechecked" as const, hold_reasons: reasons,
      failures: failures.map(row => ({ ...row, error: FAILURE })),
      verification_errors: last && !last.ok ? ["archive verification failed; run audit verify for artifact details"] : [] };
  }
}

export function archiveObservations(store: Store): ArchiveObservations {
  let result = stores.get(store);
  if (!result) { result = new ArchiveObservations(store); stores.set(store, result); }
  return result;
}
