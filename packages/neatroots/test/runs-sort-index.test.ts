import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { computeInsights } from "../src/store/insights.js";
import { tmpHome } from "./helpers.js";

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

/** The query plan of each captured statement that orders or filters runs by start time. */
function plans(st: Store, fn: () => void): string[] {
  const byStart = capture(st, fn).filter((q) => /FROM runs\b/.test(q.sql) && q.sql.includes("COALESCE(started_ms, received_ms)"));
  return byStart.map((q) => (st.db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args) as { detail: string }[]).map((r) => r.detail).join(" | "));
}

describe("runs ordered by start time", () => {
  it("are listed newest first from an index, without scanning and sorting every run", () => {
    const st = open();
    const list = plans(st, () => st.listRuns({ limit: 50 }));
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("USING INDEX runs_sort");
    expect(list[0]).not.toContain("TEMP B-TREE"); // was: SCAN runs | USE TEMP B-TREE FOR ORDER BY
  });

  it("are picked for an Insights window from the index, without scanning every run", () => {
    const st = open();
    const insights = plans(st, () => computeInsights(st.db, "30d", []));
    expect(insights.length).toBeGreaterThan(0);
    for (const p of insights) {
      expect(p).toMatch(/SEARCH runs USING (COVERING )?INDEX runs_sort/);
      expect(p).not.toMatch(/SCAN runs\b/); // was: SCAN runs
    }
  });

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
