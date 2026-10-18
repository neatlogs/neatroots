import type { Store } from "../store/db.js";
import type { KeyValue, ResourceSpansBatch } from "../otlp/types.js";

/** Only local batch attempt IDs are retained. Foreign values become one conflict bit. */
export class BatchEvidence {
  constructor(private readonly store: Store) {
    const db = store.db;
    if (!(db.prepare("PRAGMA table_info(replay_batch_members)").all() as { name: string }[]).some((c) => c.name === "deleted"))
      db.exec("ALTER TABLE replay_batch_members ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    db.exec(`DROP TRIGGER IF EXISTS replay_batch_delete_run;
      DROP TRIGGER IF EXISTS replay_batch_delete_batch;
      DROP TABLE IF EXISTS replay_deleted_traces;
      CREATE TABLE IF NOT EXISTS replay_evidence_conflicts (trace_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS replay_batch_delete_batch AFTER DELETE ON replay_batches BEGIN
        DELETE FROM replay_batch_exits WHERE replay_id IN (SELECT replay_id FROM replay_batch_members WHERE batch_id=OLD.id);
        DELETE FROM replay_evidence WHERE replay_id IN (SELECT replay_id FROM replay_batch_members WHERE batch_id=OLD.id);
        DELETE FROM replay_batch_members WHERE batch_id=OLD.id;
        DELETE FROM replay_batch_original WHERE batch_id=OLD.id;
        DELETE FROM replay_evidence_conflicts WHERE trace_id NOT IN (SELECT trace_id FROM replay_evidence);
        DELETE FROM replay_observations WHERE trace_id NOT IN (SELECT trace_id FROM replay_evidence UNION SELECT trace_id FROM replay_batches);
        DELETE FROM replay_evaluation_failures WHERE trace_id NOT IN (SELECT trace_id FROM replay_evidence UNION SELECT trace_id FROM replay_batches);
      END;
      CREATE TRIGGER replay_batch_delete_run AFTER DELETE ON runs BEGIN
        UPDATE replay_batch_members SET deleted=1 WHERE replay_id IN (SELECT replay_id FROM replay_evidence WHERE trace_id=OLD.trace_id);
        DELETE FROM replay_batch_exits WHERE replay_id IN (SELECT replay_id FROM replay_evidence WHERE trace_id=OLD.trace_id);
        DELETE FROM replay_batches WHERE trace_id=OLD.trace_id;
        DELETE FROM replay_evidence WHERE trace_id=OLD.trace_id;
        DELETE FROM replay_evidence_conflicts WHERE trace_id=OLD.trace_id;
        DELETE FROM replay_observations WHERE trace_id=OLD.trace_id;
        DELETE FROM replay_evaluation_failures WHERE trace_id=OLD.trace_id;
      END;
      DELETE FROM replay_evidence WHERE replay_id NOT IN (SELECT replay_id FROM replay_batch_members WHERE deleted=0);
      DELETE FROM replay_observations WHERE trace_id NOT IN (SELECT trace_id FROM replay_evidence UNION SELECT trace_id FROM replay_batches);
      DELETE FROM replay_evaluation_failures WHERE trace_id NOT IN (SELECT trace_id FROM replay_evidence UNION SELECT trace_id FROM replay_batches);`);
  }

  relevant(trace: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM replay_evidence WHERE trace_id=? UNION ALL
      SELECT 1 FROM replay_batches WHERE trace_id=? LIMIT 1`).get(trace, trace);
  }

  observe(batches: ResourceSpansBatch[]): Set<string> {
    const attempts = new Set<string>();
    const db = this.store.db;
    const candidates = new Set<string>();
    const fresh = new Set<string>();
    for (const batch of batches) for (const span of batch.spans) {
      if (db.prepare("SELECT 1 FROM replay_evidence WHERE trace_id=?").get(span.traceId)) candidates.add(span.traceId);
      for (const a of [...(batch.resource.attributes ?? []).slice(0, 512), ...(span.attributes ?? []).slice(0, 512)]) {
        if (a.key !== "neatroots.replay.id" || !a.value || !("stringValue" in a.value)) continue;
        const id = a.value.stringValue;
        if (typeof id !== "string" || id.length !== 15 || !/^rp_[0-9a-f]{12}$/.test(id)) continue;
        if (!db.prepare("SELECT 1 FROM replay_batch_members WHERE replay_id=? AND deleted=0").get(id)) continue;
        // Two different candidate traces already prove ambiguity; additional traces add no evidence.
        const count = db.prepare("SELECT COUNT(*) AS n FROM replay_evidence WHERE replay_id=?").get(id) as { n: number };
        if (count.n < 2 && db.prepare("INSERT OR IGNORE INTO replay_evidence VALUES (?,?)").run(id, span.traceId).changes)
          fresh.add(span.traceId);
        if (db.prepare("SELECT 1 FROM replay_evidence WHERE trace_id=?").get(span.traceId)) candidates.add(span.traceId);
      }
    }
    for (const trace of candidates) {
      const ids = db.prepare("SELECT replay_id FROM replay_evidence WHERE trace_id=?").all(trace) as { replay_id: string }[];
      for (const row of ids) attempts.add(row.replay_id);
      if (db.prepare("SELECT 1 FROM replay_evidence_conflicts WHERE trace_id=?").get(trace)) continue;
      let conflict = ids.length !== 1;
      // Include this request before database replacement can hide an earlier conflicting span.
      for (const batch of batches) for (const span of batch.spans) if (span.traceId === trace) {
        for (const attrs of [batch.resource.attributes, span.attributes]) {
          if (attrs.length > 512) conflict = true;
          for (const a of attrs.slice(0, 512)) if (a.key === "neatroots.replay.id" && !this.matches(a, ids[0]?.replay_id)) conflict = true;
        }
      }
      // Backfill prior attributes only on first association. Later requests were checked
      // above, including replacements; sticky conflicts survive restart. A streaming
      // trace can grow beyond this backfill bound when every arrival was inspected.
      const spans = fresh.has(trace)
        ? db.prepare("SELECT span_id FROM spans WHERE trace_id=? LIMIT 513").all(trace) as { span_id: string }[] : [];
      if (spans.length > 512) conflict = true;
      for (const row of spans.slice(0, 512)) {
        const full = this.store.getOtlpSpan(trace, row.span_id);
        if (!full) { conflict = true; continue; }
        for (const attrs of [full.resource.attributes, full.span.attributes]) {
          if (attrs.length > 512) conflict = true;
          for (const a of attrs.slice(0, 512)) if (a.key === "neatroots.replay.id" && !this.matches(a, ids[0]?.replay_id)) conflict = true;
        }
      }
      if (conflict) db.prepare("INSERT OR IGNORE INTO replay_evidence_conflicts VALUES (?)").run(trace);
    }
    return attempts;
  }

  hasEvidence(id: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM replay_evidence WHERE replay_id=? LIMIT 1").get(id);
  }

  uniqueTrace(id: string): string | null {
    const db = this.store.db;
    if (!db.prepare("SELECT 1 FROM replay_batch_members WHERE replay_id=? AND deleted=0").get(id)) return null;
    const rows = db.prepare("SELECT trace_id FROM replay_evidence WHERE replay_id=?").all(id) as { trace_id: string }[];
    if (rows.length !== 1) return null;
    const trace = rows[0].trace_id;
    if (db.prepare("SELECT 1 FROM replay_evidence_conflicts WHERE trace_id=?").get(trace)) return null;
    const claims = db.prepare("SELECT COUNT(*) AS n FROM replay_evidence WHERE trace_id=?").get(trace) as { n: number };
    return claims.n === 1 && this.store.getRun(trace) ? trace : null;
  }

  private matches(a: KeyValue, id: string | undefined): boolean {
    return !!id && !!a.value && "stringValue" in a.value && a.value.stringValue === id;
  }
}
