import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";

/** Safe observations only: these codes never contain model/provider exception text. */
export type OutcomeReason = "evaluating" | "waiting_end" | "queued" | "no_evidence" | "coalesced" | "span_cap" | "backend_unavailable" | "evaluation_error" | "missing_answer" | "below_threshold" | "flagged" | "verification_rejected" | "suppressed" | "quiet" | "rule_unknown" | "rule_clear" | "resumed_answer";
export interface OutcomeObservation { sequence: number; attempt_id: string | null; reason: OutcomeReason; updated_ms: number; target: string | null }
export interface CheckOutcome {
  check_id: string; title: string; observations: number;
  counts: Partial<Record<OutcomeReason, number>>;
  recent: OutcomeObservation[];
}
export interface RunCheckOutcomes {
  generation: string; previous_generation: string | null; started_ms: number;
  origin: "live" | "recheck" | "resume";
  checks: CheckOutcome[]; omitted_checks: number;
}
const CHECK_LIMIT = 256;
const DETAIL_LIMIT = 32;

/** One bounded document per run. Replacing its generation fences all old asynchronous writers. */
export class CheckOutcomes {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS check_outcomes (
      trace_id TEXT PRIMARY KEY, generation TEXT NOT NULL, document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS check_outcome_checks (
      trace_id TEXT NOT NULL, check_id TEXT NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY (trace_id, check_id)
    );
    CREATE TRIGGER IF NOT EXISTS delete_check_outcome_checks AFTER DELETE ON runs BEGIN
      DELETE FROM check_outcome_checks WHERE trace_id = OLD.trace_id;
    END;
    CREATE TRIGGER IF NOT EXISTS delete_check_outcomes AFTER DELETE ON runs BEGIN
      DELETE FROM check_outcomes WHERE trace_id = OLD.trace_id;
    END;`);
  }

  begin(traceId: string, origin: RunCheckOutcomes["origin"] = "live"): string {
    const generation = randomUUID();
    if (!this.store.db.open || !this.store.getRun(traceId)) return generation;
    const previous = this.metadata(traceId);
    this.store.db.prepare("DELETE FROM check_outcome_checks WHERE trace_id = ?").run(traceId);
    const document: RunCheckOutcomes = { generation, previous_generation: previous?.generation ?? null, started_ms: Date.now(), origin, checks: [], omitted_checks: 0 };
    this.store.db.prepare("INSERT INTO check_outcomes VALUES (?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET generation=excluded.generation, document=excluded.document")
      .run(traceId, generation, JSON.stringify(document));
    return generation;
  }

  private metadata(traceId: string): RunCheckOutcomes | null {
    if (!this.store.db.open) return null;
    const row = this.store.db.prepare("SELECT document FROM check_outcomes WHERE trace_id = ?").get(traceId) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as RunCheckOutcomes : null;
  }

  read(traceId: string): RunCheckOutcomes | null {
    const document = this.metadata(traceId);
    if (!document) return null;
    const rows = this.store.db.prepare("SELECT document FROM check_outcome_checks WHERE trace_id = ? ORDER BY check_id").all(traceId) as { document: string }[];
    document.checks = rows.map((row) => JSON.parse(row.document) as CheckOutcome);
    return document;
  }

  generationOf(traceId: string): string | null {
    if (!this.store.db.open) return null;
    const row = this.store.db.prepare("SELECT generation FROM check_outcomes WHERE trace_id = ?").get(traceId) as { generation: string } | undefined;
    return row?.generation ?? null;
  }

  current(traceId: string, generation: string): boolean {
    return this.generationOf(traceId) === generation;
  }

  observe(traceId: string, generation: string, check: { id: string; title?: string }, reason: OutcomeReason, target: string | null = null, count = 1, attemptId: string | null = null): void {
    if (!this.current(traceId, generation) || !this.store.getRun(traceId)) return;
    const stored = this.store.db.prepare("SELECT document FROM check_outcome_checks WHERE trace_id = ? AND check_id = ?").get(traceId, check.id) as { document: string } | undefined;
    let row: CheckOutcome;
    if (stored) row = JSON.parse(stored.document) as CheckOutcome;
    else {
      const size = this.store.db.prepare("SELECT COUNT(*) AS n FROM check_outcome_checks WHERE trace_id = ?").get(traceId) as { n: number };
      if (size.n >= CHECK_LIMIT) {
        const document = this.metadata(traceId)!;
        document.omitted_checks += count;
        this.store.db.prepare("UPDATE check_outcomes SET document = ? WHERE trace_id = ? AND generation = ?")
          .run(JSON.stringify(document), traceId, generation);
        return;
      }
      row = { check_id: check.id, title: (check.title ?? check.id).slice(0, 200), observations: 0, counts: {}, recent: [] };
    }
    row.observations += count;
    row.counts[reason] = (row.counts[reason] ?? 0) + count;
    row.recent.push({ sequence: row.observations, attempt_id: attemptId, reason, updated_ms: Date.now(), target });
    row.recent = row.recent.slice(-DETAIL_LIMIT);
    this.store.db.prepare("INSERT INTO check_outcome_checks VALUES (?, ?, ?) ON CONFLICT(trace_id, check_id) DO UPDATE SET document=excluded.document")
      .run(traceId, check.id, JSON.stringify(row));
  }
}
