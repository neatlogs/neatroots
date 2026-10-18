import type Database from "better-sqlite3";

/** Local receipt metadata, never a producer completion marker or an exporter timestamp. */
export class RunLiveness {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS run_liveness (
      trace_id TEXT PRIMARY KEY, received_ms INTEGER NOT NULL, inferred INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0, attempted_ms INTEGER NOT NULL DEFAULT 0, summary TEXT);
      CREATE INDEX IF NOT EXISTS run_liveness_receipt ON run_liveness(inferred,received_ms);
      CREATE TRIGGER IF NOT EXISTS run_liveness_delete AFTER DELETE ON runs BEGIN
        DELETE FROM run_liveness WHERE trace_id=OLD.trace_id;
      END;`);
  }

  touch(id: string, now: number): void {
    this.db.prepare(`INSERT INTO run_liveness(trace_id,received_ms) VALUES (?,?)
      ON CONFLICT(trace_id) DO UPDATE SET received_ms=excluded.received_ms`).run(id, now);
  }

  inferred(id: string): boolean {
    return !!(this.db.prepare("SELECT inferred FROM run_liveness WHERE trace_id=?").get(id) as { inferred: number } | undefined)?.inferred;
  }

  needsEnd(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM run_liveness WHERE trace_id=? AND inferred=1 AND pending=1").get(id);
  }

  recover(id: string): void {
    this.db.prepare("UPDATE run_liveness SET inferred=0,pending=0 WHERE trace_id=?").run(id);
  }

  /** Old rows have no trustworthy receipt clock. Give a bounded page a fresh grace period. */
  seedLegacy(now: number, limit = 32): void {
    this.db.prepare(`INSERT INTO run_liveness(trace_id,received_ms)
      SELECT r.trace_id,? FROM runs r LEFT JOIN run_liveness l ON l.trace_id=r.trace_id
      WHERE l.trace_id IS NULL AND r.status='running' AND r.doctor=0 LIMIT ?`).run(now, limit);
  }

  expire(now: number, minutes: number, limit = 16): string[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT r.trace_id FROM run_liveness l JOIN runs r ON r.trace_id=l.trace_id
        WHERE r.status='running' AND r.doctor=0 AND r.root_ended=0 AND r.complete=0
          AND l.inferred=0 AND l.received_ms<=? ORDER BY l.received_ms,r.trace_id LIMIT ?`)
        .all(now - minutes * 60_000, limit) as { trace_id: string }[];
      for (const { trace_id } of rows) {
        this.db.prepare(`UPDATE runs SET status='interrupted',interrupted=1,ended_ms=?,updated_ms=?,termination_reason=? WHERE trace_id=?`)
          .run(now, now, `No spans received for ${minutes} minutes; interruption inferred from inactivity (process state unknown).`, trace_id);
        this.db.prepare("UPDATE run_liveness SET inferred=1,pending=1 WHERE trace_id=?").run(trace_id);
      }
      return rows.map(r => r.trace_id);
    })();
  }

  pending(now: number, limit: number): string[] {
    const rows = this.db.prepare(`SELECT trace_id FROM run_liveness WHERE inferred=1 AND pending=1
      ORDER BY attempted_ms,trace_id LIMIT ?`).all(limit) as { trace_id: string }[];
    for (const { trace_id } of rows) this.db.prepare("UPDATE run_liveness SET attempted_ms=? WHERE trace_id=?").run(now, trace_id);
    return rows.map(r => r.trace_id);
  }

  settled(id: string): void { this.db.prepare("UPDATE run_liveness SET pending=0 WHERE trace_id=?").run(id); }
  rememberSummary(id: string, text: string): void { this.db.prepare("UPDATE run_liveness SET summary=? WHERE trace_id=?").run(text, id); }
  clearSummary(id: string): void {
    this.db.prepare(`DELETE FROM summaries WHERE trace_id=? AND text=(SELECT summary FROM run_liveness WHERE trace_id=?)`).run(id, id);
    this.db.prepare("UPDATE run_liveness SET summary=NULL WHERE trace_id=?").run(id);
  }
}
