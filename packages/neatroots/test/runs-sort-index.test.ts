import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
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

const plan = (st: Store, sql: string, ...args: unknown[]) =>
  (st.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" | ");

describe("runs ordered by start time", () => {
  it("are listed newest first from an index, without scanning and sorting every run", () => {
    const st = open();
    const list = plan(st, "SELECT * FROM runs WHERE doctor = 0 ORDER BY COALESCE(started_ms, received_ms) DESC LIMIT 50");
    expect(list).toContain("USING INDEX runs_sort");
    expect(list).not.toContain("TEMP B-TREE"); // was: SCAN runs | USE TEMP B-TREE FOR ORDER BY
    const window = plan(st, "SELECT trace_id FROM runs WHERE doctor = 0 AND COALESCE(started_ms, received_ms) >= ? AND COALESCE(started_ms, received_ms) < ?", 0, 1);
    expect(window).toMatch(/SEARCH runs USING (COVERING )?INDEX runs_sort/); // was: SCAN runs
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
