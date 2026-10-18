import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReadonlySql, SQL_ROW_CAP } from "../src/mcp/sql-runner.js";

describe("query_sql runner", () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-sql-"));
    file = path.join(dir, "store.db");
    const db = new Database(file);
    db.exec("CREATE TABLE runs (project TEXT, note TEXT)");
    const add = db.prepare("INSERT INTO runs VALUES (?, ?)");
    for (let i = 0; i < 300; i++) add.run(i % 2 ? "a" : "b", "x".repeat(3000));
    db.close();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns rows, caps them and clips long strings", async () => {
    const all = await runReadonlySql(file, "SELECT project, note FROM runs");
    expect(all.truncated).toBe(true);
    expect(all.rows).toHaveLength(SQL_ROW_CAP);
    expect((all.rows[0].note as string).length).toBe(2000);
    const grouped = await runReadonlySql(file, "SELECT project, COUNT(*) AS n FROM runs GROUP BY project ORDER BY project");
    expect(grouped).toEqual({ rows: [{ project: "a", n: 150 }, { project: "b", n: 150 }], truncated: false });
  });

  it("stops a query whose first row never comes, without blocking the event loop", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    const started = Date.now();
    const forever = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) AS n FROM c";
    await expect(runReadonlySql(file, forever, { timeoutMs: 1000 })).rejects.toThrow(/longer than 1s and was stopped/);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(ticks).toBeGreaterThan(5);
    const sorted = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c ORDER BY n DESC";
    await expect(runReadonlySql(file, sorted, { timeoutMs: 500 })).rejects.toThrow(/was stopped/);
  });

  it("passes SQLite errors through and refuses statements that return no rows", async () => {
    await expect(runReadonlySql(file, "SELECT * FROM nope")).rejects.toThrow(/no such table/);
    await expect(runReadonlySql(file, "CREATE TABLE x (a)")).rejects.toThrow(/return rows|readonly/i);
  });

  it("opens the store read-only", async () => {
    await expect(runReadonlySql(file, "WITH x AS (SELECT 1) DELETE FROM runs RETURNING *")).rejects.toThrow(/readonly|read-only|attempt to write/i);
    const left = await runReadonlySql(file, "SELECT COUNT(*) AS n FROM runs");
    expect(left.rows).toEqual([{ n: 300 }]);
  });
});
