import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { log as logger } from "../src/util/log.js";
import { batch, hex, span, s, tmpHome } from "./helpers.js";

const open: { store: Store; home: string }[] = [];
function setup() {
  const home = tmpHome();
  const store = new Store(path.join(home, "data"));
  open.push({ store, home });
  return store;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, home } of open.splice(0)) {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
function run(st: Store, traceId = hex(16), payload = "small") {
  st.ingest([batch([span({ traceId, name: "run", kind: "workflow", attrs: [s("payload", payload)] })])]);
  return traceId;
}
function log(st: Store, traceId: string | null, received = Date.now(), body = "log") {
  return Number(st.db.prepare("INSERT INTO logs (trace_id, body, received_ms) VALUES (?, ?, ?)").run(traceId, body, received).lastInsertRowid);
}

it("ages NULL and non-NULL orphan logs in bounded batches, preserving fresh and owned logs", () => {
  const st = setup();
  const pinned = run(st);
  st.setPinned(pinned, true);
  const owned = run(st);
  for (let i = 0; i < 600; i++) log(st, i % 2 ? hex(16) : null, 1);
  const fresh = log(st, hex(16));
  const keep = [fresh, log(st, owned, 1), log(st, pinned, 1)];
  const prepare = st.db.prepare.bind(st.db);
  const batches: number[] = [];
  vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (/DELETE FROM logs.*json_each/.test(sql)) {
      const original = stmt.run.bind(stmt);
      stmt.run = ((...args: unknown[]) => {
        batches.push(JSON.parse(args[0] as string).length);
        return original(...args);
      }) as typeof stmt.run;
    }
    return stmt;
  }) as typeof st.db.prepare);
  expect(st.sweep(1, Infinity)).toBe(0);
  expect(st.db.prepare("SELECT id FROM logs ORDER BY id").all()).toEqual(keep.map((id) => ({ id })));
  expect(batches.length).toBeGreaterThan(1);
  expect(Math.max(...batches)).toBeLessThanOrEqual(256);
});

it("rechecks orphan ownership at deletion, then continues past the protected batch", () => {
  const st = setup();
  const arriving = hex(16);
  const keep = Array.from({ length: 256 }, () => log(st, arriving, 1));
  for (let i = 0; i < 300; i++) log(st, hex(16), 1);
  const prepare = st.db.prepare.bind(st.db);
  let inserted = false;
  vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (/DELETE FROM logs.*json_each/.test(sql)) {
      const original = stmt.run.bind(stmt);
      stmt.run = ((...args: unknown[]) => {
        if (!inserted) { inserted = true; run(st, arriving); }
        return original(...args);
      }) as typeof stmt.run;
    }
    return stmt;
  }) as typeof st.db.prepare);
  expect(st.sweep(1, Infinity)).toBe(0);
  expect(inserted).toBe(true);
  expect(st.db.prepare("SELECT id FROM logs ORDER BY id").all()).toEqual(keep.map((id) => ({ id })));
  expect(st.getRun(arriving)).toBeDefined();
});

it("trims non-NULL orphan logs before tiny runs and leaves the next sweep idle", () => {
  const st = setup();
  const id = run(st);
  for (let i = 0; i < 600; i++) log(st, hex(16), i, "x".repeat(4000));
  const cap = Math.floor(st.storedBytes() / 4);
  expect(st.sweep(0, cap)).toBe(0);
  expect(st.getRun(id)).toBeDefined();
  expect(st.storedBytes()).toBeLessThanOrEqual(cap);
  const count = st.db.prepare("SELECT count(*) AS n FROM logs").get();
  expect(st.sweep(0, cap)).toBe(0);
  expect(st.db.prepare("SELECT count(*) AS n FROM logs").get()).toEqual(count);
});

it("does not charge unrelated metadata, resources, or protected log pages to tiny runs", () => {
  const st = setup();
  const pinned = run(st);
  st.setPinned(pinned, true);
  const tiny = run(st);
  st.db.prepare("INSERT INTO meta VALUES ('unrelated', ?)").run("m".repeat(600_000));
  st.db.prepare("INSERT INTO resources VALUES ('unreferenced', ?)").run("r".repeat(600_000));
  log(st, pinned, Date.now(), "p".repeat(600_000));
  const warn = vi.spyOn(logger, "warn");
  const cap = 300_000;
  expect(st.sweep(0, cap)).toBe(0);
  expect(st.getRun(tiny)).toBeDefined();
  expect(st.getRun(pinned)).toBeDefined();
  expect(st.storedBytes()).toBeGreaterThan(cap);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("retention remains above size cap"));
  expect(st.sweep(0, cap)).toBe(0);
  expect(st.getRun(tiny)).toBeDefined();
});

it("still evicts oldest run-owned payloads by size and old runs by age", () => {
  const st = setup();
  const ids = Array.from({ length: 12 }, (_, i) => run(st, hex(16), `${i}:` + "z".repeat(50_000)));
  ids.forEach((id, i) => st.db.prepare("UPDATE runs SET ended_ms = ?, received_ms = ? WHERE trace_id = ?").run(i + 1, i + 1, id));
  st.setPinned(ids[0], true);
  const cap = Math.floor(st.storedBytes() * 0.65);
  const removed = st.sweep(0, cap);
  expect(removed).toBeGreaterThan(0);
  expect(removed).toBeLessThan(11);
  expect(st.getRun(ids[0])).toBeDefined();
  expect(st.getRun(ids[11])).toBeDefined();
  expect(st.storedBytes()).toBeLessThanOrEqual(cap);
  expect(st.sweep(0, cap)).toBe(0);
  expect(st.sweep(1, Infinity)).toBe(11 - removed);
  expect(st.getRun(ids[0])).toBeDefined();
});

it("charges large attached logs to their owning runs rather than other tiny runs", () => {
  const st = setup();
  const tiny = run(st);
  const large = run(st);
  st.db.prepare("UPDATE runs SET ended_ms = 1, received_ms = 1 WHERE trace_id = ?").run(large);
  for (let i = 0; i < 10; i++) log(st, large, Date.now(), "l".repeat(100_000));
  const cap = Math.floor(st.storedBytes() * 0.5);
  expect(st.sweep(0, cap)).toBe(1);
  expect(st.getRun(large)).toBeUndefined();
  expect(st.getRun(tiny)).toBeDefined();
  expect(st.storedBytes()).toBeLessThanOrEqual(cap);
});

it("reports unavailable dbstat without guessing run ownership or disabling orphan retention", () => {
  const st = setup();
  const id = run(st, hex(16), "x".repeat(500_000));
  log(st, hex(16), 1);
  const prepare = st.db.prepare.bind(st.db);
  vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes("FROM dbstat")) throw new Error("no such table: dbstat");
    return prepare(sql);
  }) as typeof st.db.prepare);
  const warn = vi.spyOn(logger, "warn");
  expect(st.sweep(1, 300_000)).toBe(0);
  expect(st.getRun(id)).toBeDefined();
  expect(st.db.prepare("SELECT COUNT(*) AS n FROM logs").get()).toEqual({ n: 0 });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite dbstat is unavailable"));
  expect(st.storedBytes()).toBeGreaterThan(300_000);
});

it("accounts for 2000 spans without charging unrelated metadata or changing run membership", () => {
  const st = setup();
  const ids = Array.from({ length: 200 }, () => hex(16));
  for (const id of ids) {
    st.ingest([batch(Array.from({ length: 10 }, () => span({ traceId: id, name: "bounded-accounting", kind: "tool", attrs: [s("payload", "data ".repeat(100))] }))) ]);
  }
  st.db.prepare("INSERT INTO meta VALUES ('large-unrelated', ?)").run("m".repeat(4_000_000));
  const cap = Math.floor(st.storedBytes() * 0.85);
  const started = performance.now();
  expect(st.sweep(0, cap)).toBe(0);
  const elapsed = performance.now() - started;
  console.info(`run accounting 200 runs / 2000 spans: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(5_000);
  expect(st.countRuns()).toBe(200);
  expect(st.storedBytes()).toBeGreaterThan(cap);
});
