import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OtlpLogRecord } from "../src/otlp/codec.js";
import type { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const store = () => {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
};

const resource = { attributes: [{ key: "service.name", value: { stringValue: "app" } }] };
const scope = { name: "app" };
const log = (traceId = "", body = "x".repeat(10_000)): OtlpLogRecord => ({
  timeUnixNano: "0",
  severityText: "INFO",
  body: { stringValue: body },
  attributes: [],
  traceId,
  spanId: "",
  resource,
  scope,
});
const logCount = (st: Store, where = "1") => (st.db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ${where}`).get() as { n: number }).n;
const runs = (st: Store, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const t = hex(16);
    st.ingest([batch([span({ traceId: t, spanId: hex(8), name: `run ${i}`, kind: "workflow" })])]);
    return t;
  });

// #267: logs sent without a trace id (startup logs, background jobs) are stored with no run, so
// deleting runs never removes them. They still count toward the size cap, and each sweep deleted
// the oldest runs, healthy recent ones included, until none were left, while the store stayed over it.
describe("retention of logs that belong to no run", () => {
  it("trims logs with no run before any run, when they fill the size cap", () => {
    const st = store();
    const ids = runs(st, 3);
    st.ingestLogs(Array.from({ length: 400 }, () => log()));
    const cap = Math.floor(st.storedBytes() * 0.5);
    expect(st.sweep(999_999, cap)).toBe(0); // was: 2 runs, then the last one on the next sweep
    for (const t of ids) expect(st.getRun(t)).toBeDefined();
    expect(logCount(st)).toBeLessThan(400);
    expect(st.storedBytes()).toBeLessThanOrEqual(cap);
    expect(st.sweep(999_999, cap)).toBe(0); // and nothing more to do next time
    for (const t of ids) expect(st.getRun(t)).toBeDefined();
  });

  it("ages out logs with no run like runs, and leaves logs that belong to a run alone", () => {
    const st = store();
    const [kept] = runs(st, 1);
    const ancient = Date.now() - 30 * 86_400_000;
    st.ingestLogs([log(), log(), log(kept), log("ab".repeat(16))]);
    st.db.prepare("UPDATE logs SET received_ms = ?").run(ancient);
    st.ingestLogs([log()]); // a recent one
    st.sweep(14, Number.POSITIVE_INFINITY);
    expect(logCount(st, "trace_id IS NULL")).toBe(1); // the two old ones went, the recent one stays
    expect(logCount(st, `trace_id = '${"ab".repeat(16)}'`)).toBe(0); // old, and its run never arrived
    expect(logCount(st, `trace_id = '${kept}'`)).toBe(1); // goes with its run, not on its own
  });

  it("keeps a recent log whose run hasn't arrived yet, even over the cap", () => {
    const st = store();
    const early = "cd".repeat(16); // logs can arrive before their run's spans
    st.ingestLogs([log(early)]);
    st.ingestLogs(Array.from({ length: 200 }, () => log()));
    st.sweep(999_999, Math.floor(st.storedBytes() * 0.5));
    expect(logCount(st, `trace_id = '${early}'`)).toBe(1);
  });

  it("leaves logs alone while the store is under its cap", () => {
    const st = store();
    runs(st, 2);
    st.ingestLogs(Array.from({ length: 50 }, () => log()));
    expect(st.sweep(999_999, st.storedBytes() * 2)).toBe(0);
    expect(logCount(st)).toBe(50);
  });

  it("ages out more logs than one delete batch holds", () => {
    const st = store();
    st.ingestLogs(Array.from({ length: 5_200 }, () => log("", "short")));
    st.db.prepare("UPDATE logs SET received_ms = ?").run(Date.now() - 30 * 86_400_000);
    st.sweep(14, Number.POSITIVE_INFINITY);
    expect(logCount(st)).toBe(0);
  });
});
