import type Database from "better-sqlite3";
import type { Check } from "../checks/types.js";
import { canonicalJson, checkRevision, fingerprint } from "../checks/canonical.js";
import { newId } from "../util/ids.js";

export interface EvaluationSnapshot {
  revision: ReturnType<typeof checkRevision>;
  params: Record<string, string>;
  question: unknown;
  evidence_sha256: string;
  evidence_span_ids: string[];
  started_ms: number;
  run_identity?: string;
}

/** Capture before awaiting; caller changes cannot alter the saved evaluation. */
export function captureEvaluation(check: Check, params: Record<string, string>, question: unknown, evidence: string, spanIds: string[]): EvaluationSnapshot {
  return JSON.parse(canonicalJson({ revision: checkRevision(check), params, question, evidence_sha256: fingerprint(evidence), evidence_span_ids: spanIds, started_ms: Date.now() }));
}

export interface CheckEvaluation {
  id: string;
  trace_id: string;
  check_id: string;
  revision_id: string;
  decision_id: string | null;
  finding_id: string | null;
  snapshot: EvaluationSnapshot;
  backend: string;
  model: string | null;
  execution_settings: { provider: "unknown"; transport: "unknown"; sampling: "unknown"; evaluation?: unknown };
  created_ms: number;
}

export class CheckHistory {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS check_history_runs (trace_id TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS check_revisions (
        id TEXT PRIMARY KEY, check_id TEXT NOT NULL, definition TEXT NOT NULL, first_seen_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS check_revisions_check ON check_revisions(check_id, first_seen_ms);
      CREATE TABLE IF NOT EXISTS active_check_revisions (check_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS check_evaluations (
        id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, check_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        decision_id TEXT, finding_id TEXT, snapshot TEXT NOT NULL, backend TEXT NOT NULL, model TEXT,
        execution_settings TEXT NOT NULL, created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS check_evaluations_trace ON check_evaluations(trace_id);
      CREATE INDEX IF NOT EXISTS check_evaluations_finding ON check_evaluations(finding_id);
      CREATE INDEX IF NOT EXISTS check_evaluations_revision ON check_evaluations(revision_id);
    `);
  }

  runIdentity(traceId: string): string | undefined {
    if (!this.db.prepare("SELECT 1 FROM runs WHERE trace_id = ?").get(traceId)) return undefined;
    this.db.prepare("INSERT OR IGNORE INTO check_history_runs VALUES (?, ?)").run(traceId, newId("run-history"));
    return (this.db.prepare("SELECT identity FROM check_history_runs WHERE trace_id = ?").get(traceId) as { identity: string }).identity;
  }

  isCurrent(traceId: string, snapshot: EvaluationSnapshot): boolean {
    return !!snapshot.run_identity && this.runIdentity(traceId) === snapshot.run_identity;
  }

  private observe(revision: EvaluationSnapshot["revision"]): void {
    this.db.prepare("INSERT OR IGNORE INTO check_revisions VALUES (?, ?, ?, ?)")
      .run(revision.id, revision.check_id, revision.canonical, Date.now());
  }

  setActive(checks: Check[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM active_check_revisions").run();
      for (const check of checks) {
        const revision = checkRevision(check);
        this.observe(revision);
        this.db.prepare("INSERT INTO active_check_revisions VALUES (?, ?)").run(check.id, revision.id);
      }
      this.collect();
    })();
  }

  record(traceId: string, snapshot: EvaluationSnapshot, result: { backend: string; model?: string | null; evaluation?: unknown }, decisionId: string | null = null, findingId: string | null = null): string | undefined {
    return this.db.transaction(() => {
      // A pending model call may outlive deletion. Never resurrect its run metadata.
      if (!this.db.prepare("SELECT 1 FROM runs WHERE trace_id = ?").get(traceId)) return undefined;
      if (snapshot.run_identity && !this.isCurrent(traceId, snapshot)) return undefined;
      this.observe(snapshot.revision);
      const id = newId("eval");
      this.db.prepare("INSERT INTO check_evaluations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, traceId, snapshot.revision.check_id, snapshot.revision.id, decisionId, findingId,
          canonicalJson(snapshot), result.backend, result.model ?? null,
          JSON.stringify({ provider: "unknown", transport: "unknown", sampling: "unknown", ...(result.evaluation ? { evaluation: result.evaluation } : {}) }), Date.now());
      return id;
    })();
  }

  linkFinding(evaluationId: string | undefined, findingId: string): void {
    if (evaluationId) this.db.prepare("UPDATE check_evaluations SET finding_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM findings WHERE id = ?)").run(findingId, evaluationId, findingId);
  }

  revisions(checkId: string, limit = 100, offset = 0): unknown[] {
    return (this.db.prepare(`SELECT r.*, CASE WHEN a.revision_id IS NULL THEN 0 ELSE 1 END AS active
      FROM check_revisions r LEFT JOIN active_check_revisions a ON a.revision_id = r.id
      WHERE r.check_id = ? ORDER BY r.first_seen_ms DESC, r.id LIMIT ? OFFSET ?`).all(checkId, Math.min(100, limit), offset) as Record<string, unknown>[])
      .map((r) => ({ ...r, definition: JSON.parse(r.definition as string) }));
  }

  forTrace(traceId: string, limit = 100, offset = 0): CheckEvaluation[] {
    return (this.db.prepare("SELECT * FROM check_evaluations WHERE trace_id = ? ORDER BY created_ms, id LIMIT ? OFFSET ?").all(traceId, Math.min(100, limit), offset) as Record<string, unknown>[])
      .map((r) => ({ ...(r as unknown as CheckEvaluation), snapshot: JSON.parse(r.snapshot as string), execution_settings: JSON.parse(r.execution_settings as string) }));
  }

  pageInfo(kind: "trace" | "check" | "finding", id: string, limit = 100, offset = 0) {
    const [table, column] = kind === "check" ? ["check_revisions", "check_id"] : ["check_evaluations", kind === "trace" ? "trace_id" : "finding_id"];
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n;
    return { total, limit, offset, truncated: offset + limit < total };
  }

  /** finding_id's index includes rowid: a bounded lookup in actual insertion order, even within one millisecond. */
  latestForFinding(findingId: string): Pick<CheckEvaluation, "revision_id" | "snapshot"> | undefined {
    const row = this.db.prepare("SELECT revision_id, snapshot FROM check_evaluations WHERE finding_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(findingId) as { revision_id: string; snapshot: string } | undefined;
    return row ? { revision_id: row.revision_id, snapshot: JSON.parse(row.snapshot) } : undefined;
  }

  forFinding(findingId: string): CheckEvaluation[] {
    return (this.db.prepare("SELECT * FROM check_evaluations WHERE finding_id = ? ORDER BY created_ms, id LIMIT 25").all(findingId) as Record<string, unknown>[])
      .map((r) => ({ ...(r as unknown as CheckEvaluation), snapshot: JSON.parse(r.snapshot as string), execution_settings: JSON.parse(r.execution_settings as string) }));
  }

  summaries(traceId: string) {
    return this.db.prepare("SELECT id, check_id, revision_id, decision_id, finding_id, backend, model, created_ms FROM check_evaluations WHERE trace_id = ? ORDER BY created_ms, id LIMIT 25").all(traceId);
  }

  /** Active/referenced definitions survive, plus the latest 2,000 unreferenced revisions globally. */
  collect(): void {
    this.db.exec(`DELETE FROM check_revisions WHERE id NOT IN (SELECT revision_id FROM active_check_revisions)
      AND id NOT IN (SELECT revision_id FROM check_evaluations)
      AND id NOT IN (SELECT id FROM check_revisions
        WHERE id NOT IN (SELECT revision_id FROM active_check_revisions)
          AND id NOT IN (SELECT revision_id FROM check_evaluations)
        ORDER BY first_seen_ms DESC, id LIMIT 2000)`);
  }
}
