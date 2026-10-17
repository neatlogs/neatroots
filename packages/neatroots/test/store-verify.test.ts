import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, SCHEMA_VERSION } from "../src/store/db.js";
import { missingPayload } from "../src/store/blobs.js";
import { batch, closeTrackedStores, hex, makeRoots, s, span, tmpHome, trackedStore } from "./helpers.js";

// A store is a database plus a payload tree beside it. A copy that takes only the database keeps
// every reference and loses every payload, so what is missing has to be visible.

const homes: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
function store(): { st: Store; home: string } {
  const home = tmpHome();
  homes.push(home);
  return { st: trackedStore(path.join(home, "data")), home };
}
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** A run with one payload above the blob threshold. Returns its trace id and the payload's sha. */
function runWithPayload(st: Store, fill = "x"): { t: string; sha: string; big: string } {
  const t = hex(16);
  const root = hex(8);
  const big = fill.repeat(100_000);
  st.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.input", big)] })])]);
  const row = st.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(t) as { blobs: string | null };
  return { t, sha: JSON.parse(row.blobs!)[0] as string, big };
}

/** The run's payload attribute, whichever position it ended up in. */
function payloadAttr(st: Store, traceId: string): string {
  const span = st.getOtlpSpan(traceId, st.getRun(traceId)!.root_span_id!)!.span;
  return (span.attributes.find((a) => a.key === "neatlogs.workflow.input")!.value as { stringValue: string }).stringValue;
}

const blobFile = (home: string, sha: string) => path.join(home, "data", "blobs", sha.slice(0, 2), sha.slice(2));

describe("a payload that is not on disk", () => {
  it("reads back as a notice naming it, not as an empty string", () => {
    const { st, home } = store();
    const { t, sha, big } = runWithPayload(st);
    expect(payloadAttr(st, t)).toBe(big);

    fs.rmSync(blobFile(home, sha));
    // An empty string hid the loss on the run page, over the API, over MCP and in a forward.
    expect(payloadAttr(st, t)).not.toBe("");
    expect(payloadAttr(st, t)).toBe(missingPayload({ sha, len: big.length }));
    expect(payloadAttr(st, t)).toContain(sha);
    // The reference itself is still there, so the payload can be identified and restored.
    expect(st.verify().missing).toEqual([sha]);
  });

  it("is listed by verify, which also reports the rest of the store", () => {
    const { st, home } = store();
    const { sha } = runWithPayload(st);
    const clean = st.verify();
    expect(clean).toMatchObject({ quick_check: "ok", schema_version: String(SCHEMA_VERSION), referenced: 1, present: 1, missing: [], orphaned: [] });
    expect(clean.present_bytes).toBe(100_000);
    expect(clean.referenced_bytes).toBe(100_000);
    expect(clean.file).toContain("neatroots.db");

    fs.rmSync(blobFile(home, sha));
    const damaged = st.verify();
    expect(damaged).toMatchObject({ quick_check: "ok", referenced: 1, present: 0, missing: [sha], referenced_bytes: 0, present_bytes: 0 });
  });

  it("reports a payload file nothing references any more", () => {
    const { st, home } = store();
    runWithPayload(st);
    const stray = path.join(home, "data", "blobs", "ab", "orphan");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "stray", "utf8");
    const r = st.verify();
    expect(r.missing).toEqual([]);
    expect(r.orphaned).toEqual(["ab" + "orphan"]);
    expect(r.referenced).toBe(1);
    expect(r.present).toBe(2);
  });

  it("scopes the lookup to the traces asked about", () => {
    const { st, home } = store();
    const { t: damaged, sha } = runWithPayload(st, "x");
    const { t: healthy } = runWithPayload(st, "y");
    fs.rmSync(blobFile(home, sha));
    expect(st.missingBlobs([damaged])).toEqual([sha]);
    expect(st.missingBlobs([healthy])).toEqual([]);
    expect(st.missingBlobs()).toEqual([sha]);
  });

  it("refuses to forward a run whose payloads are gone instead of sending placeholders", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    const sink = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close, sink.close);
    const t = hex(16);
    const root = hex(8);
    const big = "x".repeat(100_000);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.input", big)] })])]);
    const sha = (JSON.parse((tb.roots.store.db.prepare("SELECT blobs FROM spans").get() as { blobs: string }).blobs) as string[])[0];

    // Whole store: it forwards, payload and all.
    const ok = await tb.roots.relay.forward([t], "test", { endpoint: sink.url, apiKey: "nl-test-key" });
    expect(ok.status).toBe("ok");
    const sent = sink.roots.store.batchesForTraces([t]).flatMap((b) => b.spans).find((x) => x.spanId === root)!;
    expect((sent.attributes.find((a) => a.key === "neatlogs.workflow.input")!.value as { stringValue: string }).stringValue).toBe(big);

    // Payload gone: refused, with the reason, and nothing sent.
    fs.rmSync(path.join(tb.roots.home, "data", "blobs", sha.slice(0, 2), sha.slice(2)));
    const refused = await tb.roots.relay.forward([t], "test", { endpoint: sink.url, apiKey: "nl-test-key" });
    expect(refused.status).toBe("error");
    expect(refused.error).toMatch(/payload file\(s\) this run references are missing/);
    expect(refused.error).toMatch(/store verify/);
    expect(refused.span_count).toBe(0);
  });
});

describe("the store says which schema it is", () => {
  it("records its own version and reads it back", () => {
    const { st } = store();
    expect(st.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("refuses a store written by a newer neatroots, with a readable message", () => {
    const { st, home } = store();
    st.setMeta("schema_version", String(SCHEMA_VERSION + 1));
    st.close();
    closeTrackedStores();
    expect(() => new Store(path.join(home, "data"))).toThrow(/newer neatroots/);
    expect(() => new Store(path.join(home, "data"))).toThrow(new RegExp(`schema ${SCHEMA_VERSION + 1}`));
  });
});
