import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { computeInsights } from "../src/store/insights.js";
import { batch, hex, span, tmpHome } from "./helpers.js";

// The run list and Insights order and filter runs by COALESCE(started_ms, received_ms). Without an
// index on that expression, every page load scanned the whole runs table and sorted it.

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function open(dir?: string): Store {
  const h = dir ?? tmpHome();
  if (!dir) homes.push(h);
  const st = new Store(path.join(h, "data"));
  stores.push(st);
  return st;
}

/** Runs `fn` and returns every statement it ran on the store, with the values it bound. */
function capture(st: Store, fn: () => void): { sql: string; args: unknown[] }[] {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db = st.db as Database.Database;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    for (const m of ["all", "get", "iterate", "run"] as const) {
      const orig = (stmt as any)[m].bind(stmt);
      (stmt as any)[m] = (...args: unknown[]) => {
        seen.push({ sql, args });
        return orig(...args);
      };
    }
    return stmt;
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare as typeof db.prepare;
  }
  return seen;
}

/**
 * Fills the store with runs whose start times are all different, ingested out of order so the
 * table's own order differs from start order. Returns their ids newest first.
 */
function fill(st: Store, n = 300): string[] {
  const ids = Array.from({ length: n }, () => hex(16));
  const batches = ids.map((t) => batch([span({ traceId: t, name: "agent", kind: "AGENT" })])); // start times increase
  for (let i = batches.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [batches[i], batches[j]] = [batches[j], batches[i]];
  }
  for (const b of batches) st.ingest([b]);
  return ids.reverse();
}

/**
 * A store in use for a while: runs spread over about four months, so most are outside the Insights
 * window. (When every run is inside the window, reading the whole table is the better plan, and
 * SQLite picks it once it has statistics.)
 */
function fillOverMonths(st: Store, n = 300): void {
  fill(st, n);
  st.db.prepare("UPDATE runs SET started_ms = started_ms - (rowid % 120) * 86400000").run();
}

/** The query plan of each captured statement that orders or filters runs by start time. */
function plans(st: Store, fn: () => void): string[] {
  const byStart = capture(st, fn).filter((q) => /FROM runs\b/.test(q.sql) && q.sql.includes("COALESCE(started_ms, received_ms)"));
  return byStart.map((q) => (st.db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args) as { detail: string }[]).map((r) => r.detail).join(" | "));
}

describe("runs ordered by start time", () => {
  it("are listed newest first", () => {
    const st = open();
    const newest = fill(st);
    expect(st.listRuns({ limit: 50 }).map((r) => r.trace_id)).toEqual(newest.slice(0, 50));
    expect(st.listRuns({ limit: 50, offset: 50 }).map((r) => r.trace_id)).toEqual(newest.slice(50, 100));
  });

  // neatroots never runs ANALYZE, so real stores have no index statistics; check both cases.
  for (const analyzed of [false, true]) {
    const stats = analyzed ? "with index statistics" : "without index statistics";

    it(`are listed from an index, without scanning and sorting every run (${stats})`, () => {
      const st = open();
      fillOverMonths(st);
      if (analyzed) st.db.exec("ANALYZE");
      const list = plans(st, () => st.listRuns({ limit: 50 }));
      expect(list).toHaveLength(1);
      expect(list[0]).toContain("USING INDEX runs_sort");
      expect(list[0]).not.toContain("TEMP B-TREE"); // was: SCAN runs | USE TEMP B-TREE FOR ORDER BY
    });

    it(`are picked for an Insights window from the index, without scanning every run (${stats})`, () => {
      const st = open();
      fillOverMonths(st);
      if (analyzed) st.db.exec("ANALYZE");
      const insights = plans(st, () => computeInsights(st.db, "30d", []));
      expect(insights.length).toBeGreaterThan(0);
      for (const p of insights) {
        expect(p).toMatch(/SEARCH runs USING (COVERING )?INDEX runs_sort/);
        expect(p).not.toMatch(/SCAN runs\b/); // was: SCAN runs
      }
    });
  }

  it("get the index on a store created before it existed", () => {
    const h = tmpHome();
    homes.push(h);
    open(h).close();
    stores.length = 0;
    const db = new Database(Store.dbFile(path.join(h, "data")));
    db.exec("DROP INDEX runs_sort");
    db.close();
    const st = open(h);
    expect(st.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'runs_sort'").get()).toBeDefined();
  });
});
