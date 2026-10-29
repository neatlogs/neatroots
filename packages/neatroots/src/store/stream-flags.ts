import { setImmediate } from "node:timers/promises";
import type Database from "better-sqlite3";

const FLAG = `COALESCE((SELECT json_type(a.value, '$.value.boolValue') = 'true'
  FROM json_each(attributes) AS a WHERE json_extract(a.value, '$.key') = 'neatlogs.stream.cancelled'
  ORDER BY CAST(a.key AS INTEGER) DESC LIMIT 1), 0)`;

/** Indexed cancellation flags, with yielding backfill for stores written before this projection. */
export class StreamFlags {
  /** Add the projection without scanning payloads; triggers also support older writers. */
  constructor(private readonly db: Database.Database) {
    const columns = db.prepare("PRAGMA table_info(spans)").all() as { name: string }[];
    if (!columns.some(c => c.name === "stream_cancelled")) db.exec("ALTER TABLE spans ADD COLUMN stream_cancelled INTEGER");
    db.exec(`CREATE TABLE IF NOT EXISTS span_stream_flags (
        trace_id TEXT NOT NULL, span_id TEXT NOT NULL, cancelled INTEGER NOT NULL,
        PRIMARY KEY(trace_id, span_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS span_stream_cancelled ON span_stream_flags(trace_id, cancelled, span_id);
      CREATE TABLE IF NOT EXISTS span_stream_progress (
        trace_id TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS spans_stream_insert AFTER INSERT ON spans
      BEGIN
        INSERT OR REPLACE INTO span_stream_flags SELECT trace_id, span_id, COALESCE(stream_cancelled, ${FLAG})
          FROM spans WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
      END;
      CREATE TRIGGER IF NOT EXISTS spans_stream_update AFTER UPDATE OF attributes ON spans BEGIN
        INSERT OR REPLACE INTO span_stream_flags SELECT trace_id, span_id, ${FLAG}
          FROM spans WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
      END;
      CREATE TRIGGER IF NOT EXISTS spans_stream_delete AFTER DELETE ON spans BEGIN
        DELETE FROM span_stream_flags WHERE trace_id = OLD.trace_id AND span_id = OLD.span_id;
      END;
      CREATE TRIGGER IF NOT EXISTS runs_stream_delete AFTER DELETE ON runs BEGIN
        DELETE FROM span_stream_flags WHERE trace_id = OLD.trace_id;
        DELETE FROM span_stream_progress WHERE trace_id = OLD.trace_id;
      END;`);
  }

  /** A newly created run has no legacy spans; its insert triggers cover every row. */
  newTrace(traceId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO span_stream_progress(trace_id, complete) VALUES (?, 1)").run(traceId);
  }

  /** Backfill at most 16 old rows per turn; completed reads use only the compact index. */
  async cancelled(traceId: string): Promise<Set<string>> {
    const exists = this.db.prepare("SELECT 1 FROM runs WHERE trace_id = ?");
    if (!exists.get(traceId)) return new Set();
    const progress = this.db.prepare("SELECT cursor, complete FROM span_stream_progress WHERE trace_id = ?").get(traceId) as { cursor: string; complete: number } | undefined;
    const pending = this.db.prepare("SELECT span_id FROM spans WHERE trace_id = ? AND span_id > ? ORDER BY span_id LIMIT 16");
    const update = this.db.prepare(`INSERT OR IGNORE INTO span_stream_flags SELECT trace_id, span_id, ${FLAG}
      FROM spans WHERE trace_id = ? AND span_id = ?
      AND NOT EXISTS (SELECT 1 FROM span_stream_flags WHERE trace_id = ? AND span_id = ?)`);
    /** Commit one bounded page and its cursor together without replacing newer flags. */
    const fill = this.db.transaction((rows: { span_id: string }[]) => {
      for (const row of rows) update.run(traceId, row.span_id, traceId, row.span_id);
      this.db.prepare(`INSERT INTO span_stream_progress(trace_id, cursor, complete) VALUES (?, ?, ?)
        ON CONFLICT(trace_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), complete = MAX(complete, excluded.complete)`)
        .run(traceId, rows.at(-1)?.span_id ?? '', Number(rows.length < 16));
    });
    let cursor = progress?.cursor ?? '';
    while (!progress?.complete) {
      if (!exists.get(traceId)) return new Set();
      const rows = pending.all(traceId, cursor) as { span_id: string }[];
      fill(rows);
      if (rows.length < 16) break;
      cursor = rows[rows.length - 1].span_id;
      await setImmediate();
    }
    const rows = this.db.prepare("SELECT span_id FROM span_stream_flags WHERE trace_id = ? AND cancelled = 1").all(traceId) as { span_id: string }[];
    return new Set(rows.map(row => row.span_id));
  }
}
