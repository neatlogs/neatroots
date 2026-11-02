import type Database from "better-sqlite3";
import type { Store } from "./db.js";
import type { Finding } from "../types.js";

export interface ProjectDismissal {
  project: string | null;
  name: string;
  runs: number;
  dismissed: number;
  newest_finding_id: string | null;
}

/** Home only acts on counted, open findings, never quiet/resolved ones or doctor runs. */
export function newestHomeFinding(db: Database.Database, checkId: string, project: string): string | null {
  const row = db.prepare(`SELECT f.id FROM findings f JOIN runs r ON r.trace_id = f.trace_id
    WHERE f.check_id = ? AND r.project = ? AND r.doctor = 0 AND f.status IN ('raised', 'active')
    ORDER BY f.created_ms DESC, f.id DESC LIMIT 1`).get(checkId, project) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Lifetime counts match Store.dismissalsIn, rather than Home's selected time window. */
export function projectDismissal(db: Database.Database, checkId: string, project: string | null, name: string, runs: number): ProjectDismissal {
  // A legacy run without a project must not be treated as a project literally named "unknown".
  if (project === null) return { project, name, runs, dismissed: 0, newest_finding_id: null };
  const row = db.prepare(`SELECT COUNT(*) AS n FROM findings f JOIN runs r ON r.trace_id = f.trace_id
    WHERE f.check_id = ? AND r.project = ? AND f.status = 'dismissed'`).get(checkId, project) as { n: number };
  return { project, name, runs, dismissed: row.n, newest_finding_id: newestHomeFinding(db, checkId, project) };
}

export interface HomeDismissTarget { finding_id: string; check_id: string; project: string }
type DismissResult = { finding: Finding; changed: boolean } | { error: string; status: 404 | 409 };

/** Compare the displayed identity and mutate in one transaction; retries never advance the target. */
export function dismissHomeFinding(store: Store, target: HomeDismissTarget): DismissResult {
  return store.db.transaction((): DismissResult => {
    const finding = store.getFinding(target.finding_id);
    if (!finding) return { error: "Finding no longer exists. Refresh Home and try again.", status: 404 } as const;
    const run = store.getRun(finding.trace_id);
    if (!run || run.project !== target.project || finding.check_id !== target.check_id || run.doctor) {
      return { error: "Finding does not belong to this check and project. Refresh Home and try again.", status: 409 } as const;
    }
    if (finding.status === "dismissed") return { finding, changed: false } as const;
    if (newestHomeFinding(store.db, target.check_id, target.project) !== finding.id) {
      return { error: "The newest open finding changed. Review the refreshed Home row and try again.", status: 409 } as const;
    }
    return { finding: store.updateFinding(finding.id, { status: "dismissed" })!, changed: true } as const;
  })();
}
