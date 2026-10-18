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
    this.ready = this.mappingAvailable() && this.inSync();
  }

  private mappingAvailable(): boolean {
    return !(this.db.prepare("SELECT rebuilding FROM retention_search_state WHERE id = 1").get() as { rebuilding: number }).rebuilding;
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
      ? `SELECT ${cols} FROM span_fts_ids WHERE (SELECT rebuilding FROM retention_search_state WHERE id = 1) = 0
          AND id NOT IN (SELECT id FROM retention_pending_fts) AND id IN (SELECT rowid FROM span_fts WHERE span_fts MATCH @match)
        UNION ALL SELECT ${cols} FROM span_fts WHERE span_fts MATCH @match
          AND (SELECT rebuilding FROM retention_search_state WHERE id = 1) = 1 AND ${this.visible()}`
      : `SELECT ${cols} FROM span_fts WHERE span_fts MATCH @match AND ${this.visible()}`;
  }

  /** Tombstones hide derived rows at the canonical deletion commit, before physical GC. */
  visible(): string { return "+rowid NOT IN (SELECT id FROM retention_pending_fts)"; }

  refresh(): void { this.ready = this.mappingAvailable() && this.inSync(); }

  /** A condition on span_fts rows: they belong to one of `n` runs, given as parameters. */
  inRuns(n: number): string {
    const list = Array(n).fill("?").join(",");
    // +rowid keeps the list out of FTS5, which would otherwise run the MATCH once per listed row
    // (slow for long runs); as a plain filter it is checked against each match's rowid instead.
    return `(${this.visible()}) AND (${this.ready && this.mappingAvailable() ? `+rowid IN (SELECT id FROM span_fts_ids WHERE trace_id IN (${list}))` : `trace_id IN (${list})`})`;
  }

  /** Records the run and span of a span_fts row just inserted. A rowid can be reused after a delete. */
  add(rowid: number | bigint, traceId: string, spanId: string): void {
    // An INSERT may reuse the highest deleted rowid, including for the same span identity.
    this.db.prepare("DELETE FROM retention_pending_fts WHERE id = ?").run(rowid);
    this.db.prepare("INSERT OR REPLACE INTO span_fts_ids (id, trace_id, span_id) VALUES (?, ?, ?)").run(rowid, traceId, spanId);
  }

  deleteSpan(traceId: string, spanId: string): void {
    if (this.ready && this.mappingAvailable()) this.db.prepare("DELETE FROM span_fts WHERE rowid IN (SELECT id FROM span_fts_ids WHERE trace_id = ? AND span_id = ?)").run(traceId, spanId);
    else this.db.prepare("DELETE FROM span_fts WHERE trace_id = ? AND span_id = ?").run(traceId, spanId);
    this.db.prepare("DELETE FROM retention_pending_fts WHERE trace_id = ? AND span_id = ?").run(traceId, spanId);
    this.db.prepare("DELETE FROM span_fts_ids WHERE trace_id = ? AND span_id = ?").run(traceId, spanId);
  }

  /** Deletes the span_fts rows of runs, given as a JSON array of trace ids. */
  deleteRuns(traceIdsJson: string): void {
    const inIds = "trace_id IN (SELECT value FROM json_each(?))";
    if (this.ready && this.mappingAvailable()) this.db.prepare(`DELETE FROM span_fts WHERE rowid IN (SELECT id FROM span_fts_ids WHERE ${inIds})`).run(traceIdsJson);
    else this.db.prepare(`DELETE FROM span_fts WHERE ${inIds}`).run(traceIdsJson);
    this.db.prepare(`DELETE FROM retention_pending_fts WHERE ${inIds}`).run(traceIdsJson);
    this.db.prepare(`DELETE FROM span_fts_ids WHERE ${inIds}`).run(traceIdsJson);
  }

  /** Called inside the owner's canonical deletion transaction; mappings remain until GC. */
  queueRuns(traceIdsJson: string): void {
    if (!this.ready) throw new Error("retention search mappings unavailable");
    const state = this.db.prepare("SELECT rebuilding FROM retention_search_state WHERE id = 1").get() as { rebuilding: number };
    if (state.rebuilding) throw new Error("retention search mappings rebuilding");
    this.db.prepare(`INSERT OR IGNORE INTO retention_pending_fts(id, trace_id, span_id)
      SELECT id, trace_id, span_id FROM span_fts_ids WHERE trace_id IN (SELECT value FROM json_each(?))`).run(traceIdsJson);
  }

  /** Derived-index maintenance only. Snapshot, identity check and delete share a writer lock. */
  collectPending(limit = 64): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, trace_id, span_id FROM retention_pending_fts ORDER BY id LIMIT ?").all(limit) as Row[];
      for (const row of rows) {
        const current = this.db.prepare("SELECT trace_id, span_id FROM span_fts WHERE rowid = ?").get(BigInt(row.id)) as Omit<Row, "id"> | undefined;
        if (current?.trace_id === row.trace_id && current.span_id === row.span_id) {
          this.db.prepare("DELETE FROM span_fts WHERE rowid = ?").run(BigInt(row.id));
          this.db.prepare("DELETE FROM span_fts_ids WHERE id = ?").run(row.id);
        } else if (!current) {
          this.db.prepare("DELETE FROM span_fts_ids WHERE id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM retention_pending_fts WHERE id = ?").run(row.id);
      }
      return rows.length;
    }).immediate();
  }

  /**
   * Fills span_fts_ids from span_fts when they differ, a thousand rows at a time so startup and
   * ingest aren't held up. Rows indexed meanwhile are recorded as usual.
   */
  rebuild(onDone?: (rows: number, ready: boolean) => void, onChunk?: (rows: number) => void): void {
    if (this.ready) {
      setImmediate(() => onDone?.(0, true));
      return;
    }
    if (this.rebuilding) return;
    try {
      this.db.transaction(() => {
        this.db.prepare("UPDATE retention_search_state SET rebuilding = 1 WHERE id = 1").run();
        this.db.prepare("DELETE FROM span_fts_ids").run();
      }).immediate();
    } catch {
      setImmediate(() => onDone?.(0, false));
      return;
    }
    this.rebuilding = true;
    const read = this.db.prepare("SELECT rowid AS id, trace_id, span_id FROM span_fts WHERE rowid > ? ORDER BY rowid LIMIT ?");
    const insert = this.db.prepare("INSERT OR IGNORE INTO span_fts_ids (id, trace_id, span_id) VALUES (@id, @trace_id, @span_id)");
    const fill = this.db.transaction((after: number) => {
      const rows = read.all(BigInt(after), CHUNK) as Row[];
      for (const r of rows) insert.run(r);
      return rows;
    });
    let after = 0;
    let n = 0;
    const step = () => {
      if (!this.db.open) return;
      let rows: Row[];
      try {
        // A BigInt binds as an integer. FTS5 ignores a rowid bound given as a real (which a JS
        // number binds as) and scans from the first row, so each chunk would read all before it.
        // Read and map under one writer lock: GC cannot delete a row between the snapshot and fill.
        rows = fill.immediate(after);
      } catch {
        // The database is busy or failing: keep the scans (always correct) and try at the next start.
        this.rebuilding = false;
        onDone?.(n, false);
        return;
      }
      n += rows.length;
      if (rows.length) onChunk?.(rows.length);
      if (rows.length === CHUNK) {
        after = rows[rows.length - 1].id;
        setImmediate(step);
        return;
      }
      this.rebuilding = false;
      try {
        this.ready = this.db.transaction(() => {
          const ready = this.inSync();
          if (ready) this.db.prepare("UPDATE retention_search_state SET rebuilding = 0 WHERE id = 1").run();
          return ready;
        }).immediate();
      } catch { this.ready = false; }
      onDone?.(n, this.ready);
    };
    setImmediate(step);
  }
}
