import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { Roots } from "../src/core.js";
import type { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, poll, span, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
function dataDir(): string {
  const h = tmpHome();
  homes.push(h);
  return path.join(h, "data");
}
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** One run: a workflow root with one tool call whose output is `output`. */
function run(st: Store, output: string, tool = "lookup"): string {
  const traceId = hex(16);
  const root = span({ traceId, name: "agent", kind: "workflow" });
  st.ingest([batch([root, toolSpan(traceId, root.spanId, tool, "{}", output)])]);
  return traceId;
}

/** Sends a run's tool call again with a new output, as an exporter retry with fresh content does. */
function resend(st: Store, traceId: string, output: string, tool = "lookup"): void {
  const call = st.getSpans(traceId).find((x) => x.tool_name === tool)!;
  st.ingest([batch([{ ...toolSpan(traceId, call.parent_span_id!, tool, "{}", output), spanId: call.span_id }])]);
}

/** Every search the store answers from the full-text index. */
function searches(st: Store) {
  const ids = (rows: { trace_id: string }[]) => rows.map((r) => r.trace_id).sort();
  const page = st.listRuns({ limit: 500 }).map((r) => r.trace_id);
  return {
    text: ids(st.listRuns({ text: "invoice", limit: 500 })),
    count: st.countMatchingRuns({ text: "invoice" }),
    tool: ids(st.listRuns({ text: "invoice", tool: "billing", limit: 500 })),
    snippets: st.searchSpans("invoice", 1000, page).map((h) => `${h.trace_id}:${h.span_id}:${h.snippet}`).sort(),
  };
}

/** span_fts_ids holds exactly the run and span of every span_fts row. */
function idsMatchIndex(st: Store): void {
  const ids = st.db.prepare("SELECT id, trace_id, span_id FROM span_fts_ids ORDER BY id").all();
  expect(ids).toEqual(st.db.prepare("SELECT rowid AS id, trace_id, span_id FROM span_fts ORDER BY rowid").all());
}

const rebuilt = (st: Store) => new Promise<boolean>((resolve) => st.rebuildSearchIds((_rows, ready) => resolve(ready)));

/** The SQL the store prepares while `fn` runs. */
function prepared(st: Store, fn: () => void): string[] {
  const seen: string[] = [];
  const prepare = st.db.prepare.bind(st.db);
  st.db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof st.db.prepare;
  try {
    fn();
  } finally {
    st.db.prepare = prepare;
  }
  return seen;
}

describe("search index run ids", () => {
  it("stay in step with ingest, re-sent spans and deleted runs", () => {
    const st = trackedStore(dataDir());
    const a = run(st, "invoice 1 is overdue");
    run(st, "nothing to see");
    idsMatchIndex(st);

    resend(st, a, "paid in full");
    expect(st.listRuns({ text: "invoice" })).toEqual([]);
    expect(st.listRuns({ text: "paid" }).map((r) => r.trace_id)).toEqual([a]);
    idsMatchIndex(st);

    st.deleteRun(a);
    expect(st.listRuns({ text: "paid" })).toEqual([]);
    idsMatchIndex(st);
  });

  it("are filled in for a store from an older version, with the same search results before and after", async () => {
    const dir = dataDir();
    let st = trackedStore(dir);
    const runs = Array.from({ length: 30 }, (_, i) => run(st, i % 3 ? `invoice ${i}` : `receipt ${i}`, i % 2 ? "billing" : "shipping"));
    // As a store written by 0.2.8, which had no run ids for the index.
    st.db.exec("DROP TABLE span_fts_ids");
    st.close();
    st = trackedStore(dir);
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM span_fts_ids").get()).toEqual({ n: 0 });

    // Until they are filled in, spans are still indexed and replaced correctly.
    const late = run(st, "invoice sent late", "billing");
    resend(st, runs[1], "paid in full", "billing");
    const before = searches(st);
    expect(before.text).toContain(late);
    expect(before.text).not.toContain(runs[1]);
    expect(before.count).toBe(20);

    expect(await rebuilt(st)).toBe(true);
    idsMatchIndex(st);
    expect(searches(st)).toEqual(before);
    // The re-sent span has one index row, not its old one as well.
    const call = st.getSpans(runs[1]).find((x) => x.tool_name === "billing")!;
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM span_fts WHERE trace_id = ? AND span_id = ?").get(runs[1], call.span_id)).toEqual({ n: 1 });
  });

  it("are filled in a thousand rows at a time on a larger store", async () => {
    const dir = dataDir();
    let st = trackedStore(dir);
    for (let i = 0; i < 2600; i++) run(st, i % 2 ? `invoice ${i}` : `receipt ${i}`, "billing");
    st.db.exec("DROP TABLE span_fts_ids");
    st.close();
    st = trackedStore(dir);
    const before = searches(st);
    expect(before.count).toBe(1300);
    expect(await rebuilt(st)).toBe(true);
    idsMatchIndex(st);
    expect(searches(st)).toEqual(before);
  });

  it("are rebuilt when an older version wrote to the store after this one", async () => {
    const dir = dataDir();
    let st = trackedStore(dir);
    run(st, "invoice a");
    // An older version indexes a run without recording its run ids.
    const b = run(st, "invoice b");
    st.db.prepare("DELETE FROM span_fts_ids WHERE trace_id = ?").run(b);
    st.close();
    st = trackedStore(dir);
    expect(st.listRuns({ text: "invoice b" }).map((r) => r.trace_id)).toEqual([b]);
    expect(await rebuilt(st)).toBe(true);
    idsMatchIndex(st);
    expect(st.listRuns({ text: "invoice b" }).map((r) => r.trace_id)).toEqual([b]);
  });

  it("are rebuilt when an older version reused the rowids of the newest index rows", async () => {
    const dir = dataDir();
    let st = trackedStore(dir);
    run(st, "alpha");
    const b = run(st, "bravo");
    const c = run(st, "charlie");
    // An older version deletes the newest index rows (run c's) and indexes as many other spans.
    // SQLite gives those the same rowids, so the row count and the highest rowid don't change.
    const top = (st.db.prepare("SELECT rowid AS id FROM span_fts WHERE trace_id = ?").all(c) as { id: number }[]).map((r) => r.id);
    const before = st.db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS m FROM span_fts").get();
    st.db.prepare(`DELETE FROM span_fts WHERE rowid IN (${top.map(() => "?").join(",")})`).run(...top);
    for (const _ of top) st.db.prepare("INSERT INTO span_fts (trace_id, span_id, name, tool_name, body) VALUES (?, ?, 'lookup', 'lookup', 'delta')").run(b, hex(8));
    expect(st.db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS m FROM span_fts").get()).toEqual(before);
    st.close();
    st = trackedStore(dir);
    expect(st.listRuns({ text: "delta" }).map((r) => r.trace_id)).toEqual([b]);
    expect(st.searchSpans("delta", 10, [b]).map((h) => h.trace_id)).toEqual([b, b]);
    expect(await rebuilt(st)).toBe(true);
    idsMatchIndex(st);
    expect(st.listRuns({ text: "delta" }).map((r) => r.trace_id)).toEqual([b]);
    expect(st.searchSpans("delta", 10, [b]).map((h) => h.trace_id)).toEqual([b, b]);
  });

  it("keep the scans when filling them in fails, and fill them in on a later try", async () => {
    const dir = dataDir();
    let st = trackedStore(dir);
    const a = run(st, "invoice a");
    st.db.exec("DROP TABLE span_fts_ids");
    st.close();
    st = trackedStore(dir);
    const prepare = st.db.prepare.bind(st.db);
    st.db.prepare = ((sql: string) => {
      if (!sql.includes("WHERE rowid > ?")) return prepare(sql);
      return {
        all: () => {
          throw new Error("database is locked");
        },
      };
    }) as unknown as typeof st.db.prepare;
    try {
      expect(await rebuilt(st)).toBe(false);
    } finally {
      st.db.prepare = prepare;
    }
    expect(st.listRuns({ text: "invoice" }).map((r) => r.trace_id)).toEqual([a]);
    expect(await rebuilt(st)).toBe(true);
    idsMatchIndex(st);
  });

  it("look up a page's snippets with one match scan, not one match per span", () => {
    const st = trackedStore(dataDir());
    const t = run(st, "invoice");
    const sql = prepared(st, () => st.searchSpans("invoice", 10, [t])).find((q) => q.includes("snippet(span_fts"))!;
    const plan = (st.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('"invoice"', t, 10) as { detail: string }[]).map((r) => r.detail).join(" ");
    // After the colon FTS5 lists what it was given: M is the match, = a rowid it would look up one by one.
    expect(plan).toMatch(/span_fts VIRTUAL TABLE INDEX \d+:M/);
    expect(st.searchSpans("invoice", 10, [t]).map((h) => h.trace_id)).toEqual([t]);
  });

  it("change with the index in each re-index chunk, which stops cleanly on an error", async () => {
    const st = trackedStore(dataDir());
    for (let i = 0; i < 3; i++) run(st, `invoice ${i}`);
    // As a store from before search covered whole values: no version marker, so it is re-indexed.
    st.db.prepare("DELETE FROM meta WHERE key = 'search_index'").run();
    const reindexed = () => new Promise<[number, boolean]>((resolve) => st.reindexSearch((n, ok) => resolve([n, ok])));
    const prepare = st.db.prepare.bind(st.db);
    const failing = async (fails: (sql: string) => boolean) => {
      st.db.prepare = ((sql: string) => {
        if (fails(sql)) throw new Error("database is locked");
        return prepare(sql);
      }) as typeof st.db.prepare;
      try {
        return await reindexed();
      } finally {
        st.db.prepare = prepare;
      }
    };
    let writes = 0;
    expect((await failing((sql) => sql.startsWith("INSERT OR REPLACE INTO span_fts_ids") && ++writes === 3))[1]).toBe(false);
    // The failed chunk rolled back as a whole, so the run ids still match the index.
    idsMatchIndex(st);
    expect(st.getMeta("search_index")).toBeUndefined();
    // Every chunk committed but recording that it finished failed: reported, not thrown.
    expect(await failing((sql) => sql.startsWith("INSERT OR REPLACE INTO meta"))).toEqual([6, false]);
    idsMatchIndex(st);
    expect(st.getMeta("search_index")).toBeUndefined();
    expect(await reindexed()).toEqual([6, true]);
    idsMatchIndex(st);
    expect(st.searchSpans("invoice").length).toBe(3);
  });

  it("are filled in before an old store is re-indexed at start, so re-indexing doesn't scan the index for each span", async () => {
    const dir = dataDir();
    const st = trackedStore(dir);
    for (let i = 0; i < 20; i++) run(st, `invoice ${i}`);
    // A store from before 0.2.5: no run ids and no search_index marker, so both startup jobs are due.
    st.db.exec("DROP TABLE span_fts_ids");
    st.db.prepare("DELETE FROM meta WHERE key = 'search_index'").run();
    st.close();
    // Every statement prepared while neatroots starts on that store.
    const seen: string[] = [];
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (this: Database.Database, sql: string) {
      seen.push(sql);
      return prepare.call(this, sql);
    } as typeof prepare;
    const cfg = defaultConfig();
    cfg.classifier.laya.enabled = false;
    let roots: Roots | undefined;
    try {
      roots = new Roots({ home: path.dirname(dir), config: cfg, noEngine: true });
      await poll(async () => roots!.store.getMeta("search_index") === "2");
    } finally {
      Database.prototype.prepare = prepare;
    }
    try {
      expect(seen.filter((q) => q.startsWith("DELETE FROM span_fts WHERE trace_id"))).toEqual([]);
      idsMatchIndex(roots.store);
      expect(roots.store.searchSpans("invoice").length).toBe(20);
    } finally {
      roots.close();
    }
  });

  it("are tried again when filling them in fails, and an old store is re-indexed only through them", async () => {
    // An old store (no run ids, no search_index marker) whose first fill-in attempts fail.
    const oldStore = () => {
      const dir = dataDir();
      const st = trackedStore(dir);
      for (let i = 0; i < 20; i++) run(st, `invoice ${i}`);
      st.db.exec("DROP TABLE span_fts_ids");
      st.db.prepare("DELETE FROM meta WHERE key = 'search_index'").run();
      st.close();
      return trackedStore(dir);
    };
    const failing = (st: Store, failures: number) => {
      const seen: string[] = [];
      const prepare = st.db.prepare.bind(st.db);
      let left = failures;
      st.db.prepare = ((sql: string) => {
        seen.push(sql);
        if (sql.includes("WHERE rowid > ?") && left-- > 0) return { all: () => { throw new Error("database is locked"); } };
        return prepare(sql);
      }) as unknown as typeof st.db.prepare;
      return { seen, restore: () => (st.db.prepare = prepare) };
    };
    const scans = (seen: string[]) => seen.filter((q) => q.startsWith("DELETE FROM span_fts WHERE trace_id"));

    // Fails once, then works: the re-index runs after, through the run ids.
    let st = oldStore();
    let spy = failing(st, 1);
    const reindexed = await new Promise<boolean>((resolve) => st.maintainSearch(undefined, (_n, ok) => resolve(ok), 10));
    spy.restore();
    expect(reindexed).toBe(true);
    expect(scans(spy.seen)).toEqual([]);
    idsMatchIndex(st);
    expect(st.getMeta("search_index")).toBe("2");

    // Fails every time: reported once, and the re-index waits for the next start.
    st = oldStore();
    spy = failing(st, 3);
    let reindexCalled = false;
    const ids = await new Promise<boolean>((resolve) => st.maintainSearch((_n, ready) => resolve(ready), () => (reindexCalled = true), 10));
    await new Promise((r) => setTimeout(r, 50));
    spy.restore();
    expect(ids).toBe(false);
    expect(reindexCalled).toBe(false);
    expect(scans(spy.seen)).toEqual([]);
    expect(st.getMeta("search_index")).toBeUndefined();
  });

  it("keep ingest, search and deletes from reading every index row", async () => {
    // Filtering span_fts on trace_id or span_id (unindexed columns) loads every row's text.
    const scan = /FROM span_fts WHERE trace_id|SELECT trace_id(, span_id)? FROM span_fts |MATCH \? AND trace_id/;
    const scans = (st: Store) =>
      prepared(st, () => {
        const t = run(st, "invoice again", "billing");
        resend(st, t, "invoice paid", "billing");
        st.listRuns({ text: "invoice" });
        st.countMatchingRuns({ text: "invoice" });
        st.listRuns({ text: "invoice", tool: "billing" });
        st.searchSpans("invoice", 10, [t]);
        st.deleteRun(t);
      }).filter((q) => scan.test(q));
    const dir = dataDir();
    let st = trackedStore(dir);
    run(st, "invoice");
    expect(scans(st)).toEqual([]);

    // The same calls scan on a store whose run ids aren't filled in yet, so the check above can fail.
    st.db.exec("DROP TABLE span_fts_ids");
    st.close();
    st = trackedStore(dir);
    expect(scans(st).length).toBeGreaterThan(0);
    // A span stored for the first time has no index rows to delete, filled in or not.
    expect(prepared(st, () => run(st, "invoice new")).filter((q) => q.includes("DELETE FROM span_fts"))).toEqual([]);
    expect(await rebuilt(st)).toBe(true);
    expect(scans(st)).toEqual([]);
  });
});
