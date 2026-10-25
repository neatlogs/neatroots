import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
}
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const DAY_NS = 86_400_000n * 1_000_000n;

/** A workflow run whose spans ended `daysAgo` days in the past, as an imported historical trace. */
function historicalBatch(traceId: string, daysAgo: number, imported: boolean) {
  const endNs = BigInt(Date.now()) * 1_000_000n - BigInt(daysAgo) * DAY_NS;
  const root = span({ traceId, spanId: hex(8), name: "historical-root", kind: "workflow", attrs: [s("neatlogs.workflow.input", '"old"')] });
  root.startTimeUnixNano = (endNs - 1_000_000_000n).toString();
  root.endTimeUnixNano = endNs.toString();
  const b = batch([root]);
  if (imported) b.resource.attributes.push(s("neatroots.import.source", "file"));
  return b;
}

describe("imported run retention", () => {
  it("keeps a freshly imported historical run through age sweeps", () => {
    const st = store();
    const t = hex(16);
    st.ingest([historicalBatch(t, 20, true)]);
    const run = st.getRun(t)!;
    expect(run.status).toBe("ok");
    expect(run.ended_ms!).toBeLessThan(Date.now() - 19 * 86_400_000);
    // The age sweep must not delete a run imported moments ago just because its spans are old.
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(0);
    expect(st.getRun(t)).toBeDefined();
  });

  it("ages an imported run out by when it was received, not its span times", () => {
    const st = store();
    const t = hex(16);
    st.ingest([historicalBatch(t, 20, true)]);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(0);
    // Once the import itself is older than the retention window, the run goes.
    st.db.prepare("UPDATE runs SET received_ms = ? WHERE trace_id = ?").run(Date.now() - 15 * 86_400_000, t);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(1);
    expect(st.getRun(t)).toBeUndefined();
  });

  it("still prunes old live runs that were never imported", () => {
    const st = store();
    const t = hex(16);
    st.ingest([historicalBatch(t, 20, false)]);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(1);
    expect(st.getRun(t)).toBeUndefined();
  });

  it("marks a run imported when the import source arrives on a later span", () => {
    const st = store();
    const t = hex(16);
    // First span arrives without the import marker (partial import, retried batch, ...).
    const first = historicalBatch(t, 20, false);
    const firstSpanId = first.spans[0].spanId;
    st.ingest([first]);
    const again = historicalBatch(t, 20, true);
    again.spans[0].spanId = firstSpanId;
    st.ingest([again]);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(0);
    expect(st.getRun(t)).toBeDefined();
  });

  it("ages an imported run by its receipt time even when its spans ended recently", () => {
    const st = store();
    const t = hex(16);
    st.ingest([historicalBatch(t, 1, true)]);
    st.db.prepare("UPDATE runs SET received_ms = ? WHERE trace_id = ?").run(Date.now() - 15 * 86_400_000, t);
    expect(st.sweep(14, Number.POSITIVE_INFINITY)).toBe(1);
    expect(st.getRun(t)).toBeUndefined();
  });

  it("protects runs imported before the imported column existed, after an upgrade", () => {
    const h = tmpHome();
    homes.push(h);
    const dir = path.join(h, "data");
    const old = trackedStore(dir);
    const imported = hex(16);
    const live = hex(16);
    old.ingest([historicalBatch(imported, 20, true), historicalBatch(live, 20, false)]);
    // Put the database back in its pre-upgrade shape: no imported column.
    old.db.exec("ALTER TABLE runs DROP COLUMN imported");
    old.close();
    const upgraded = trackedStore(dir);
    expect((upgraded.db.prepare("SELECT imported FROM runs WHERE trace_id = ?").get(imported) as { imported: number }).imported).toBe(1);
    expect((upgraded.db.prepare("SELECT imported FROM runs WHERE trace_id = ?").get(live) as { imported: number }).imported).toBe(0);
    // The sweep keeps the imported run (received just now) and prunes the old live one.
    expect(upgraded.sweep(14, Number.POSITIVE_INFINITY)).toBe(1);
    expect(upgraded.getRun(imported)).toBeDefined();
    expect(upgraded.getRun(live)).toBeUndefined();
  });
});
