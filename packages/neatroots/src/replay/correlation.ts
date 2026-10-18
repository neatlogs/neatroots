import type { Store, TraceUpdate } from "../store/db.js";
import type { KeyValue, ResourceSpansBatch } from "../otlp/types.js";

export type Attribution = "explicit" | "fallback-unverified" | "ambiguous" | "unknown";
export interface Association { trace: string | null; attribution: Attribution; reason: string }
const KEY = "neatroots.replay.id";
// Bounds include completed attempts, so late contradictory telemetry can revoke attribution.
export const CORRELATION_LIMITS = { attempts: 256, candidates: 512, totalCandidates: 4096, attributes: 512, active: 64 };
interface Window { replay_id: string; project: string | null; active: number; overlapped: number; overflow: number }
interface Candidate { trace_id: string; eligible: number; authority: number; claimed: number; deleted: number }

/** One persisted authority for ordinary replays and batch consumers. No span hydration/backfill. */
export class ReplayCorrelation {
  constructor(private readonly store: Store) {
    store.db.transaction(() => store.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_windows (
        replay_id TEXT PRIMARY KEY, project TEXT, active INTEGER NOT NULL,
        overlapped INTEGER NOT NULL DEFAULT 0, overflow INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS replay_windows_active ON replay_windows(active);
      CREATE TABLE IF NOT EXISTS replay_candidates (
        replay_id TEXT NOT NULL, trace_id TEXT NOT NULL, eligible INTEGER NOT NULL,
        authority INTEGER NOT NULL DEFAULT 0, claimed INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(replay_id,trace_id)
      );
      CREATE INDEX IF NOT EXISTS replay_candidates_trace ON replay_candidates(trace_id);
      CREATE TABLE IF NOT EXISTS replay_trace_claims (
        trace_id TEXT PRIMARY KEY, value TEXT, has_claim INTEGER NOT NULL DEFAULT 0,
        conflict INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS replays_generated ON replays(generated_trace_id);
      DROP TRIGGER IF EXISTS replay_window_evicted;
      DROP TRIGGER IF EXISTS replay_correlation_deleted;
      CREATE TRIGGER replay_window_evicted AFTER DELETE ON replay_windows BEGIN
        UPDATE replays SET attribution='unknown', attribution_reason='Replay attribution evidence was pruned or exceeded its capacity.',
          new_trace_id=NULL, output_preview=CASE WHEN generated_trace_id IS NOT NULL THEN output_preview ELSE NULL END WHERE id=OLD.replay_id;
        DELETE FROM replay_candidates WHERE replay_id=OLD.replay_id;
        DELETE FROM replay_trace_claims WHERE trace_id NOT IN (SELECT trace_id FROM replay_candidates);
      END;
      CREATE TRIGGER IF NOT EXISTS replay_correlation_deleted AFTER DELETE ON runs BEGIN
        UPDATE replay_candidates SET deleted=1 WHERE trace_id=OLD.trace_id;
        DELETE FROM replay_trace_claims WHERE trace_id=OLD.trace_id;
        UPDATE replays SET attribution='unknown', attribution_reason='The associated run was deleted; reused trace IDs are not evidence.',
          new_trace_id=NULL, output_preview=NULL WHERE new_trace_id=OLD.trace_id;
        UPDATE replays SET output_preview=NULL, output_revoked=1 WHERE trace_id=OLD.trace_id OR generated_trace_id=OLD.trace_id;
        DELETE FROM replay_windows WHERE replay_id IN (SELECT id FROM replays WHERE trace_id=OLD.trace_id);
      END;
    `))();
  }

  open(id: string, project: string | null): Set<string> {
    const db = this.store.db;
    const evicted = new Set<string>();
    while ((db.prepare("SELECT COUNT(*) AS n FROM replay_windows").get() as { n: number }).n >= CORRELATION_LIMITS.attempts) {
      const row = db.prepare("SELECT replay_id FROM replay_windows ORDER BY active, rowid LIMIT 1").get() as { replay_id: string };
      evicted.add(row.replay_id);
      db.prepare("DELETE FROM replay_windows WHERE replay_id=?").run(row.replay_id);
    }
    const active = (db.prepare("SELECT COUNT(*) AS n FROM replay_windows WHERE active=1").get() as { n: number }).n;
    db.prepare("UPDATE replay_windows SET overlapped=1 WHERE active=1").run();
    if (active >= CORRELATION_LIMITS.active) db.prepare("UPDATE replay_windows SET overflow=1 WHERE active=1").run();
    db.prepare("INSERT INTO replay_windows VALUES (?,?,1,?,?)").run(id, project, Number(active > 0), Number(active >= CORRELATION_LIMITS.active));
    return evicted;
  }

  close(id: string): void {
    this.store.db.prepare("UPDATE replay_windows SET active=0 WHERE replay_id=?").run(id);
  }

  private candidate(id: string, trace: string, eligible: number): boolean {
    const db = this.store.db;
    if (db.prepare("SELECT 1 FROM replay_candidates WHERE replay_id=? AND trace_id=?").get(id, trace)) return true;
    if (!db.prepare("SELECT 1 FROM replay_windows WHERE replay_id=?").get(id)) return false;
    const n = (db.prepare("SELECT COUNT(*) AS n FROM replay_candidates WHERE replay_id=?").get(id) as { n: number }).n;
    const total = (db.prepare("SELECT COUNT(*) AS n FROM replay_candidates").get() as { n: number }).n;
    if (n >= CORRELATION_LIMITS.candidates || total >= CORRELATION_LIMITS.totalCandidates) {
      db.prepare("UPDATE replay_windows SET overflow=1 WHERE replay_id=?").run(id);
      return false;
    }
    db.prepare("INSERT INTO replay_candidates(replay_id,trace_id,eligible) VALUES (?,?,?)").run(id, trace, eligible);
    return true;
  }

  /** Inspect the original request, including superseded spans and duplicate attributes. */
  observe(batches: ResourceSpansBatch[], updates: TraceUpdate[] = []): Set<string> {
    const db = this.store.db;
    const affected = new Set<string>();
    const boundedUpdates = updates.slice(0, CORRELATION_LIMITS.totalCandidates);
    const fresh = new Set(boundedUpdates.filter((u) => u.runCreated).map((u) => u.traceId));
    const known = new Set(boundedUpdates.map((u) => u.traceId));
    const truncated = updates.length > CORRELATION_LIMITS.totalCandidates;
    if (truncated) db.prepare("UPDATE replay_windows SET overflow=1 WHERE active=1").run();
    const windows = db.prepare("SELECT * FROM replay_windows WHERE active=1 LIMIT ?").all(CORRELATION_LIMITS.active) as Window[];
    const seen = new Set<string>();
    const local = new Map<string, boolean>();
    const owns = (id: string) => {
      // At most the bounded registry's local IDs enter this cache; foreign IDs are not retained.
      if (!local.has(id)) {
        if (!db.prepare("SELECT 1 FROM replay_windows WHERE replay_id=?").get(id)) return false;
        local.set(id, true);
      }
      return local.get(id)!;
    };
    for (const batch of batches) for (const span of batch.spans) {
      const trace = span.traceId;
      if (!seen.has(trace) && seen.size < CORRELATION_LIMITS.totalCandidates) {
        seen.add(trace);
        if (fresh.has(trace)) for (const window of windows) {
          affected.add(window.replay_id);
          this.candidate(window.replay_id, trace, 1);
        }
      }
      let summary = db.prepare("SELECT value,has_claim,conflict FROM replay_trace_claims WHERE trace_id=?").get(trace) as
        { value: string | null; has_claim: number; conflict: number } | undefined;
      summary ??= { value: null, has_claim: 0, conflict: 0 };
      for (const [attrs, authority] of [[batch.resource.attributes ?? [], true], [span.attributes ?? [], !span.parentSpanId]] as [KeyValue[], boolean][]) {
        if (attrs.length > CORRELATION_LIMITS.attributes) summary.conflict = 1;
        for (const a of attrs.slice(0, CORRELATION_LIMITS.attributes)) {
          if (a.key !== KEY) continue;
          summary.has_claim = 1;
          const value = a.value && "stringValue" in a.value && typeof a.value.stringValue === "string" ? a.value.stringValue : null;
          // Foreign/malformed data is retained as a conflict bit, never raw payload text.
          const id = value && /^rp_[a-f0-9]{12}$/.test(value) && owns(value) ? value : "*";
          if (id === "*" || (summary.value !== null && summary.value !== id)) summary.conflict = 1;
          summary.value ??= id;
          if (id !== "*") {
            affected.add(id);
            // Truncation cannot establish that an omitted producer is pre-existing.
            // Only its locally claimed attempt loses certification; unrelated completed
            // attempts remain valid. The lookup and retained registry stay bounded.
            if (truncated && !known.has(trace))
              db.prepare("UPDATE replay_windows SET overflow=1 WHERE replay_id=?").run(id);
            // 0: pre-existing run (never a candidate); 1: first seen in this window;
            // 2: a new run arriving after closure (cannot link, but can prove duplication).
            const eligibility = fresh.has(trace) ? windows.some((w) => w.replay_id === id) ? 1 : 2 : 0;
            if (this.candidate(id, trace, eligibility)) {
              db.prepare("UPDATE replay_candidates SET claimed=1,authority=MAX(authority,?) WHERE replay_id=? AND trace_id=?").run(Number(authority), id, trace);
            }
          }
        }
      }
      const candidates = db.prepare("SELECT replay_id FROM replay_candidates WHERE trace_id=?").all(trace) as { replay_id: string }[];
      if (!candidates.length) continue;
      db.prepare(`INSERT INTO replay_trace_claims VALUES (?,?,?,?) ON CONFLICT(trace_id) DO UPDATE SET
        value=excluded.value,has_claim=excluded.has_claim,conflict=excluded.conflict`).run(trace, summary.value, summary.has_claim, summary.conflict);
      for (const row of candidates) affected.add(row.replay_id);
    }
    return affected;
  }

  hasEvidence(id: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM replay_candidates WHERE replay_id=? AND eligible=1 AND claimed=1 AND authority=1 LIMIT 1").get(id);
  }

  relevant(trace: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM replay_candidates WHERE trace_id=? LIMIT 1").get(trace);
  }

  select(id: string, fallback = false): Association {
    const db = this.store.db;
    const window = db.prepare("SELECT * FROM replay_windows WHERE replay_id=?").get(id) as Window | undefined;
    const unknown = (reason: string): Association => ({ trace: null, attribution: "unknown", reason });
    if (!window) return unknown("Replay attribution evidence is unavailable or was pruned.");
    if (window.overflow) return unknown("Replay attribution evidence exceeded its capacity; no run is certified.");
    const rows = db.prepare(`SELECT c.*,COALESCE(t.has_claim,0) AS has_claim,COALESCE(t.conflict,0) AS conflict
      FROM replay_candidates c LEFT JOIN replay_trace_claims t USING(trace_id) WHERE replay_id=?`).all(id) as
      (Candidate & { has_claim: number; conflict: number })[];
    const claims = rows.filter((r) => r.claimed && r.authority && r.eligible !== 0);
    if (claims.length > 1 || claims.some((r) => r.conflict))
      return { trace: null, attribution: "ambiguous", reason: "Multiple possible result traces or contradictory replay IDs; the run association was revoked." };
    if (claims.length === 1) {
      const claim = claims[0];
      if (claim.eligible !== 1) return unknown("The claimed run was not first seen during this replay window.");
      if (claim.deleted || !this.store.getRun(claim.trace_id)) return unknown("The claimed run was deleted; trace ID reuse cannot restore attribution.");
      return { trace: claim.trace_id, attribution: "explicit", reason: "A unique root or resource replay ID matches this locally owned replay." };
    }
    if (!fallback) return unknown("No unique explicit root or resource replay ID has been observed.");
    if (window.overlapped) return unknown("Replays overlapped during this window; timing cannot identify their runs.");
    if (rows.some((r) => r.eligible === 1 && r.claimed && !r.authority && !r.deleted))
      return unknown("A child-only replay ID cannot certify its run or justify selecting a different run by timing.");
    const candidates = rows.filter((r) => r.eligible === 1 && !r.deleted && !r.has_claim && !r.conflict)
      .filter((r) => this.store.getRun(r.trace_id)?.project === window.project);
    if (candidates.length > 1) return { trace: null, attribution: "ambiguous", reason: "Multiple untagged runs appeared during the replay window." };
    if (candidates.length === 1) return {
      trace: candidates[0].trace_id, attribution: "fallback-unverified",
      reason: "Run selected by timing after the full wait; replay identity is unverified.",
    };
    return unknown("No eligible run was observed; child-only, foreign or malformed replay claims do not certify a run.");
  }
}
