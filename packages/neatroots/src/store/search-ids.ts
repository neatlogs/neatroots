import type Database from "better-sqlite3";

type Counts = { n: number; m: number | null };
type Row = { id: number; trace_id: string; span_id: string };

const CHUNK = 1000;

/**
 * Finds span_fts rows by run or span through span_fts_ids (the run and span of each span_fts row,
 * by rowid). span_fts keeps trace_id and span_id as unindexed columns, so a filter on them loads
 * every row's indexed text: seconds per search on a large store, and a scan of the whole index for
 * every span ingested. A store from a version without span_fts_ids gets it filled in the
 * background; until it covers span_fts, the scans are used.
 */
export class SearchIds {
  /** True while span_fts_ids has a row for every span_fts row. */
  ready: boolean;
  private rebuilding = false;

  constructor(private readonly db: Database.Database) {
    this.ready = this.inSync();
  }

  /**
   * Same row count, highest rowid and newest rows as span_fts. FTS5 keeps one span_fts_docsize row
   * per indexed row, so that is counted: counting span_fts itself reads every row. A version
   * without span_fts_ids that writes to the store changes the count or the highest rowid, unless it
   * deletes the newest rows and adds as many: SQLite then reuses their rowids, which run up to the
   * highest one, so the newest rows no longer match. Comparing every row would read all the text.
   */
  private inSync(): boolean {
    try {
      const fts = this.db.prepare("SELECT COUNT(*) AS n, MAX(id) AS m FROM span_fts_docsize").get() as Counts;
      const ids = this.db.prepare("SELECT COUNT(*) AS n, MAX(id) AS m FROM span_fts_ids").get() as Counts;
      if (fts.n !== ids.n || fts.m !== ids.m) return false;
      const newest = (sql: string) => JSON.stringify(this.db.prepare(sql).all());
      return newest("SELECT rowid AS id, trace_id, span_id FROM span_fts ORDER BY rowid DESC LIMIT 1000") === newest("SELECT id, trace_id, span_id FROM span_fts_ids ORDER BY id DESC LIMIT 1000");
    } catch {
      return false;
    }
  }

  /** A query for `cols` (trace_id, span_id) of the span_fts rows matching @match. */
  matching(cols: string): string {
    return this.ready
      ? `SELECT ${cols} FROM span_fts_ids WHERE id IN (SELECT rowid FROM span_fts WHERE span_fts MATCH @match)`
      : `SELECT ${cols} FROM span_fts WHERE span_fts MATCH @match`;
  }

  /** A condition on span_fts rows: they belong to one of `n` runs, given as parameters. */
  inRuns(n: number): string {
    const list = Array(n).fill("?").join(",");
    // +rowid keeps the list out of FTS5, which would otherwise run the MATCH once per listed row
    // (slow for long runs); as a plain filter it is checked against each match's rowid instead.
    return this.ready ? `+rowid IN (SELECT id FROM span_fts_ids WHERE trace_id IN (${list}))` : `trace_id IN (${list})`;
  }

  /** Records the run and span of a span_fts row just inserted. A rowid can be reused after a delete. */
  add(rowid: number | bigint, traceId: string, spanId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO span_fts_ids (id, trace_id, span_id) VALUES (?, ?, ?)").run(rowid, traceId, spanId);
  }

  deleteSpan(traceId: string, spanId: string): void {
    if (this.ready) this.db.prepare("DELETE FROM span_fts WHERE rowid IN (SELECT id FROM span_fts_ids WHERE trace_id = ? AND span_id = ?)").run(traceId, spanId);
    else this.db.prepare("DELETE FROM span_fts WHERE trace_id = ? AND span_id = ?").run(traceId, spanId);
    this.db.prepare("DELETE FROM span_fts_ids WHERE trace_id = ? AND span_id = ?").run(traceId, spanId);
  }

  /** Deletes the span_fts rows of runs, given as a JSON array of trace ids. */
  deleteRuns(traceIdsJson: string): void {
    const inIds = "trace_id IN (SELECT value FROM json_each(?))";
    if (this.ready) this.db.prepare(`DELETE FROM span_fts WHERE rowid IN (SELECT id FROM span_fts_ids WHERE ${inIds})`).run(traceIdsJson);
    else this.db.prepare(`DELETE FROM span_fts WHERE ${inIds}`).run(traceIdsJson);
    this.db.prepare(`DELETE FROM span_fts_ids WHERE ${inIds}`).run(traceIdsJson);
  }

  /**
   * Fills span_fts_ids from span_fts when they differ, a thousand rows at a time so startup and
   * ingest aren't held up. Rows indexed meanwhile are recorded as usual.
   */
  rebuild(onDone?: (rows: number, ready: boolean) => void): void {
    if (this.ready) {
      setImmediate(() => onDone?.(0, true));
      return;
    }
    if (this.rebuilding) return;
    try {
      this.db.prepare("DELETE FROM span_fts_ids").run();
    } catch {
      setImmediate(() => onDone?.(0, false));
      return;
    }
    this.rebuilding = true;
    const read = this.db.prepare("SELECT rowid AS id, trace_id, span_id FROM span_fts WHERE rowid > ? ORDER BY rowid LIMIT ?");
    const insert = this.db.prepare("INSERT OR IGNORE INTO span_fts_ids (id, trace_id, span_id) VALUES (@id, @trace_id, @span_id)");
    const fill = this.db.transaction((rows: Row[]) => {
      for (const r of rows) insert.run(r);
    });
    let after = 0;
    let n = 0;
    const step = () => {
      if (!this.db.open) return;
      let rows: Row[];
      try {
        // A BigInt binds as an integer. FTS5 ignores a rowid bound given as a real (which a JS
        // number binds as) and scans from the first row, so each chunk would read all before it.
        rows = read.all(BigInt(after), CHUNK) as Row[];
        fill(rows);
      } catch {
        // The database is busy or failing: keep the scans (always correct) and try at the next start.
        this.rebuilding = false;
        onDone?.(n, false);
        return;
      }
      n += rows.length;
      if (rows.length === CHUNK) {
        after = rows[rows.length - 1].id;
        setImmediate(step);
        return;
      }
      this.rebuilding = false;
      this.ready = this.inSync();
      onDone?.(n, this.ready);
    };
    setImmediate(step);
  }
}
