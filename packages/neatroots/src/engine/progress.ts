import type { Store } from "../store/db.js";

// Which runs still have check work outstanding. Jobs themselves live in memory, so this record is
// what lets a restart (graceful or a crash) finish them instead of leaving runs half checked.

export type ProgressState = "checking" | "interrupted";

export class CheckProgress {
  private readonly marked = new Set<string>();

  constructor(private readonly store: Store) {
    store.db.exec("CREATE TABLE IF NOT EXISTS check_progress (trace_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_ms INTEGER NOT NULL)");
  }

  /** Work started for the run (written once per run per process, not per job). */
  checking(traceId: string): void {
    if (this.marked.has(traceId)) return;
    this.marked.add(traceId);
    this.set(traceId, "checking");
  }

  /** Everything accepted for the run reached an end: answered, failed or skipped. */
  done(traceId: string): void {
    this.marked.delete(traceId);
    if (!this.store.db.open) return;
    this.store.db.prepare("DELETE FROM check_progress WHERE trace_id = ?").run(traceId);
  }

  /** Left unfinished and not resumed (over the resume limit); the run page offers Re-run checks. */
  interrupted(traceId: string): void {
    this.marked.delete(traceId);
    this.set(traceId, "interrupted");
  }

  state(traceId: string): ProgressState | undefined {
    const r = this.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(traceId) as { state: ProgressState } | undefined;
    return r?.state;
  }

  /** Runs a previous process was still checking, newest first. */
  unfinished(): string[] {
    return (this.store.db.prepare("SELECT trace_id FROM check_progress WHERE state = 'checking' ORDER BY updated_ms DESC").all() as { trace_id: string }[]).map((r) => r.trace_id);
  }

  private set(traceId: string, state: ProgressState): void {
    // Jobs still in flight while neatroots shuts down: the row stays as it was, for the next start.
    if (!this.store.db.open) return;
    this.store.db
      .prepare("INSERT INTO check_progress (trace_id, state, updated_ms) VALUES (?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET state = excluded.state, updated_ms = excluded.updated_ms")
      .run(traceId, state, Date.now());
  }
}
