import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, markerSpan, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
function store() {
  const home = tmpHome();
  homes.push(home);
  return trackedStore(home);
}
afterEach(() => {
  vi.restoreAllMocks();
  closeTrackedStores();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("FTS row identity", () => {
  it("serializes concurrent Store constructors and migrates legacy search rows only once", async () => {
    const st = store();
    const original = toolSpan(hex(16), "", "lookup", "{}", "payloadneedle");
    const marker = markerSpan(original.traceId, "");
    st.ingest([batch([original, marker])]);
    st.db.exec("UPDATE span_fts SET rowid = rowid + 1000, body = 'legacyneedle'");
    st.db.prepare("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES (?, ?, '', '', 'latestneedle')").run(original.traceId, original.spanId);
    st.db.prepare("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES (?, ?, '', '', 'markerneedle')").run(original.traceId, marker.spanId);
    st.db.exec("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES ('orphan', 'orphan', '', '', 'orphanneedle'); DELETE FROM meta WHERE key = 'search_rowids'");
    st.close();

    const require = createRequire(import.meta.url);
    const gates = new Int32Array(new SharedArrayBuffer(8));
    const release = (slot: number) => { Atomics.store(gates, slot, 1); Atomics.notify(gates, slot); };
    const probe = new Database(st.file);
    probe.pragma("busy_timeout = 0");
    const workers: Worker[] = [];
    let guards = 0;
    let materialized = 0;
    let reserved = false;
    try {
      const opened = await Promise.all([0, 1].map(() => new Promise<{ error?: string; migrations: number }>((resolve, reject) => {
        // Each thread opens a real connection. Only the first metadata read and the boundary
        // between materialization and DELETE are paused; SQLite chooses the actual lock order.
        const worker = new Worker(`
          const { workerData, parentPort } = require('node:worker_threads');
          require(workerData.tsx);
          const Database = require(workerData.sqlite);
          const { Store } = require(workerData.store);
          const gates = new Int32Array(workerData.gates);
          const pause = slot => {
            if (Atomics.wait(gates, slot, 0, 10000) === 'timed-out') throw new Error('migration barrier timed out');
          };
          const prepare = Database.prototype.prepare;
          const exec = Database.prototype.exec;
          let guarded = false, migrations = 0;
          Database.prototype.prepare = function(sql) {
            const stmt = prepare.call(this, sql);
            if (sql === 'SELECT value FROM meta WHERE key = ?') {
              const get = stmt.get;
              stmt.get = function(key) {
                const row = get.call(this, key);
                if (key === 'search_rowids' && !guarded) {
                  guarded = true;
                  if (row) throw new Error('fixture already migrated');
                  parentPort.postMessage({ kind: 'guard' });
                  pause(0);
                }
                return row;
              };
            }
            return stmt;
          };
          Database.prototype.exec = function(sql) {
            if (!sql.includes('CREATE TEMP TABLE search_rows')) return exec.call(this, sql);
            migrations++;
            const cut = sql.indexOf('DELETE FROM span_fts');
            exec.call(this, sql.slice(0, cut));
            parentPort.postMessage({ kind: 'materialized' });
            pause(1);
            return exec.call(this, sql.slice(cut));
          };
          try { const st = new Store(workerData.home); st.close(); parentPort.postMessage({ kind: 'done', migrations }); }
          catch (error) { parentPort.postMessage({ kind: 'done', migrations, error: error.code || error.message }); }
        `, { eval: true, workerData: { home: st.dir, gates: gates.buffer, tsx: require.resolve("tsx/cjs"), sqlite: require.resolve("better-sqlite3"), store: fileURLToPath(new URL("../src/store/db.ts", import.meta.url)) } });
        workers.push(worker);
        let result: { error?: string; migrations: number } | undefined;
        worker.on("message", (message) => {
          if (message.kind === "guard" && ++guards === 2) release(0);
          if (message.kind === "materialized") {
            materialized++;
            if (materialized === 1) {
              // Observe the real SQLite reservation, independently of transaction API choices.
              // Deferred readers must both materialize before either attempts the write upgrade.
              try { probe.exec("BEGIN IMMEDIATE; ROLLBACK"); }
              catch (error) {
                if ((error as { code?: string }).code !== "SQLITE_BUSY") { reject(error); return; }
                reserved = true;
              }
            }
            if (reserved || materialized === 2) release(1);
          }
          if (message.kind === "done") result = message;
        });
        worker.on("error", reject);
        worker.on("exit", (code) => result && code === 0 ? resolve(result) : reject(new Error(`migration worker exit ${code}`)));
      })));
      expect(opened.map((r) => r.error).filter(Boolean)).toEqual([]);
      expect(guards).toBe(2);
      expect(reserved).toBe(true);
      expect(opened.reduce((n, r) => n + r.migrations, 0)).toBe(1);
    } finally {
      release(0); release(1);
      await Promise.all(workers.map((w) => w.terminate()));
      probe.close();
    }
    const exec = vi.spyOn(Database.prototype, "exec");
    const reopened = trackedStore(st.dir);
    expect(exec.mock.calls.some(([sql]) => sql.includes("CREATE TEMP TABLE search_rows"))).toBe(false);
    expect(reopened.getMeta("search_rowids")).toBe("1");
    expect(reopened.searchSpans("latestneedle")).toHaveLength(1);
    for (const text of ["legacyneedle", "markerneedle", "orphanneedle"]) expect(reopened.searchSpans(text)).toEqual([]);
    expect(reopened.db.prepare("SELECT rowid FROM span_fts").all()).toEqual([{ rowid: 1 }]);
    expect(reopened.getOtlpSpan(original.traceId, original.spanId)?.span.attributes).toEqual(original.attributes);
    await new Promise<number>((resolve) => reopened.reindexSearch(resolve));
    expect(reopened.searchSpans("latestneedle")).toEqual([]);
    expect(reopened.searchSpans("payloadneedle")).toHaveLength(1);
  });

  it("uses the current rowid when a second Store replaces a selected reindex row", async () => {
    const st = store();
    const original = toolSpan(hex(16), "", "lookup", "{}", "oldneedle");
    st.ingest([batch([original])]);
    const writer = trackedStore(st.dir);
    const changed = toolSpan(original.traceId, "", "lookup", "{}", "newneedle");
    changed.spanId = original.spanId;
    const prepare = st.db.prepare.bind(st.db);
    let replaced = false;
    vi.spyOn(st.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("WHERE seq > ? ORDER BY seq LIMIT 300")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = all(...args);
          if (!replaced && rows.length) {
            replaced = true;
            writer.ingest([batch([changed])]);
          }
          return rows;
        });
      }
      return statement;
    });
    await new Promise<number>((resolve) => st.reindexSearch(resolve));
    expect(replaced).toBe(true);
    expect(st.searchSpans("oldneedle")).toEqual([]);
    expect(st.searchSpans("newneedle")).toHaveLength(1);
    expect(st.db.prepare("SELECT rowid FROM span_fts").all()).toEqual(st.db.prepare("SELECT rowid FROM spans").all());
  });

  it.each(["replacement", "marker"])("serializes a concurrent %s after reading the reindex payload", async (transition) => {
    const st = store();
    const original = toolSpan(hex(16), "", "lookup", "{}", "oldneedle");
    st.ingest([batch([original])]);
    const writer = trackedStore(st.dir);
    writer.db.pragma("busy_timeout = 0");
    const changed = transition === "marker" ? markerSpan(original.traceId, "") : toolSpan(original.traceId, "", "lookup", "{}", "newneedle");
    changed.spanId = original.spanId;
    const read = st.getOtlpSpan.bind(st);
    let attempted = false;
    let blocked = false;
    let retry: Promise<void> | undefined;
    vi.spyOn(st, "getOtlpSpan").mockImplementation((trace, span) => {
      const payload = read(trace, span);
      if (!attempted) {
        attempted = true;
        try { writer.ingest([batch([changed])]); }
        catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
          blocked = true;
          retry = new Promise((resolve, reject) => setImmediate(() => {
            try { writer.ingest([batch([changed])]); resolve(); } catch (e) { reject(e); }
          }));
        }
      }
      return payload;
    });
    await new Promise<number>((resolve) => st.reindexSearch(resolve));
    await retry;
    expect(attempted).toBe(true);
    expect(st.searchSpans("oldneedle")).toEqual([]);
    expect(st.searchSpans("newneedle")).toHaveLength(transition === "marker" ? 0 : 1);
    expect(blocked).toBe(true);
    const orphans = st.db.prepare("SELECT f.rowid FROM span_fts f LEFT JOIN spans s ON f.rowid = s.rowid AND f.trace_id = s.trace_id AND f.span_id = s.span_id WHERE s.rowid IS NULL OR s.is_marker = 1").all();
    expect(orphans).toEqual([]);
  });

  it("uses rowid lookups for new spans and replacements, and removes marker transitions", () => {
    const st = store();
    const prepare = vi.spyOn(st.db, "prepare");
    const t = hex(16);
    const original = toolSpan(t, "", "lookup", "{}", "originalneedle");
    st.ingest([batch([original])]);
    st.ingest([batch([original])]);
    expect(st.searchSpans("originalneedle")).toHaveLength(1);
    const changed = toolSpan(t, "", "lookup", "{}", "replacementneedle");
    changed.spanId = original.spanId;
    st.ingest([batch([changed])]);
    expect(st.searchSpans("originalneedle")).toEqual([]);
    expect(st.searchSpans("replacementneedle")).toHaveLength(1);
    const marker = markerSpan(t, "");
    marker.spanId = original.spanId;
    st.ingest([batch([marker])]);
    expect(st.searchSpans("replacementneedle")).toEqual([]);
    st.ingest([batch([changed])]);
    expect(st.searchSpans("replacementneedle")).toHaveLength(1);
    const deletes = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith("DELETE FROM span_fts"));
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((sql) => sql === "DELETE FROM span_fts WHERE rowid = ?")).toBe(true);
    const plan = st.db.prepare("EXPLAIN QUERY PLAN DELETE FROM span_fts WHERE rowid = ?").all(1) as { detail: string }[];
    expect(plan[0].detail).toContain("INDEX 0:=");
  });

  it("migrates legacy rowids once, preserving indexed content and dropping stale rows", async () => {
    let st = store();
    const home = st.dir;
    const t = hex(16);
    const original = toolSpan(t, "", "lookup", "{}", "payloadneedle");
    const marker = markerSpan(t, "");
    st.ingest([batch([original, marker])]);
    st.db.exec("UPDATE span_fts SET rowid = rowid + 1000, body = 'legacyneedle'");
    st.db.prepare("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES (?, ?, '', '', 'stale')").run(t, marker.spanId);
    st.db.exec("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES ('orphan', 'orphan', '', '', 'stale')");
    st.db.exec("DELETE FROM meta WHERE key = 'search_rowids'");
    st.close();
    st = trackedStore(home);
    expect(st.searchSpans("legacyneedle")).toHaveLength(1);
    expect(st.searchSpans("stale")).toEqual([]);
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM span_fts f JOIN spans s ON f.rowid = s.rowid AND f.trace_id = s.trace_id AND f.span_id = s.span_id").get()).toEqual({ n: 1 });
    expect(st.getMeta("search_rowids")).toBe("1");
    await new Promise<number>((resolve) => st.reindexSearch(resolve));
    expect(st.searchSpans("legacyneedle")).toEqual([]);
    expect(st.searchSpans("payloadneedle")).toHaveLength(1);
    st.close();
    st = trackedStore(home);
    st.ingest([batch([original])]);
    expect(st.searchSpans("payloadneedle")).toHaveLength(1);
    st.deleteRuns([t]);
    expect(st.searchSpans("payloadneedle")).toEqual([]);
  });

  it("deduplicates legacy identities and leaves missing index rows for normal reindex", async () => {
    let st = store();
    const home = st.dir;
    const t = hex(16);
    const one = toolSpan(t, "", "lookup", "{}", "oneneedle");
    const two = toolSpan(t, "", "lookup", "{}", "twoneedle");
    st.ingest([batch([one, two])]);
    st.db.prepare("DELETE FROM span_fts WHERE span_id = ?").run(two.spanId);
    st.db.prepare("INSERT INTO span_fts(trace_id, span_id, name, tool_name, body) VALUES (?, ?, '', '', 'latestneedle')").run(t, one.spanId);
    st.db.exec("DELETE FROM meta WHERE key = 'search_rowids'");
    st.close();
    st = trackedStore(home);
    expect(st.searchSpans("latestneedle")).toHaveLength(1);
    expect(st.searchSpans("oneneedle")).toEqual([]);
    await new Promise<number>((resolve) => st.reindexSearch(resolve));
    expect(st.searchSpans("oneneedle")).toHaveLength(1);
    expect(st.searchSpans("twoneedle")).toHaveLength(1);
  });
  it("rolls back an interrupted migration so the next startup can retry", () => {
    let st = store();
    const home = st.dir;
    const t = hex(16);
    st.ingest([batch([toolSpan(t, "", "lookup", "{}", "rollbackneedle")])]);
    st.db.exec("UPDATE span_fts SET rowid = rowid + 1000; DELETE FROM meta WHERE key = 'search_rowids'");
    st.close();
    const originalExec = Database.prototype.exec;
    let failedDb: Database.Database | undefined;
    const fault = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      const result = originalExec.call(this, sql);
      if (sql.includes("CREATE TEMP TABLE search_rows")) {
        failedDb = this;
        throw new Error("interrupted migration");
      }
      return result;
    });
    expect(() => new Store(home)).toThrow("interrupted migration");
    fault.mockRestore();
    expect(failedDb!.prepare("SELECT rowid FROM span_fts").get()).toEqual({ rowid: 1001 });
    expect(failedDb!.prepare("SELECT value FROM meta WHERE key = 'search_rowids'").get()).toBeUndefined();
    failedDb!.close();
    st = trackedStore(home);
    expect(st.searchSpans("rollbackneedle")).toHaveLength(1);
    expect(st.db.prepare("SELECT rowid FROM span_fts").get()).toEqual({ rowid: 1 });
  });

  it("keeps search identities unique across Store instances with the same sequence counter", () => {
    const first = store();
    const second = trackedStore(first.dir);
    const a = toolSpan(hex(16), "", "lookup", "{}", "firstconnectionneedle");
    const b = toolSpan(hex(16), "", "lookup", "{}", "secondconnectionneedle");
    first.ingest([batch([a])]);
    second.ingest([batch([b])]);
    expect(first.db.prepare("SELECT COUNT(DISTINCT seq) AS n FROM spans").get()).toEqual({ n: 1 });
    expect(first.db.prepare("SELECT COUNT(DISTINCT rowid) AS n FROM span_fts").get()).toEqual({ n: 2 });
    expect(first.searchSpans("firstconnectionneedle")).toHaveLength(1);
    expect(second.searchSpans("secondconnectionneedle")).toHaveLength(1);
    first.ingest([batch([a])]);
    second.ingest([batch([b])]);
    expect(first.searchSpans("firstconnectionneedle")).toHaveLength(1);
    expect(second.searchSpans("secondconnectionneedle")).toHaveLength(1);
  });

});
