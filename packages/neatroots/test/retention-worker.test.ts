import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("retention worker", () => {
  it("keeps the event loop responsive and reclaims deleted payloads", async () => {
    t = await makeRoots({ noEngine: true });
    const traceId = hex(16);
    t.roots.ingest([batch([span({ traceId, name: "old run", kind: "workflow", attrs: [s("payload", "x".repeat(40_000))] })])]);
    t.roots.store.db.prepare("UPDATE runs SET received_ms = 1, ended_ms = 1, updated_ms = 1 WHERE trace_id = ?").run(traceId);
    t.roots.config.retention.days = 1;

    let ticks = 0;
    const ticker = setInterval(() => ticks++, 1);
    try {
      t.roots.startRetention();
      expect(t.roots.store.getRun(traceId)).toBeDefined();
      await until(() => !t!.roots.store.getRun(traceId));
      await until(() => t!.roots.store.blobs.size() === 0);
      expect(t.roots.store.getMeta("retention_blob_candidates")).toBe("[]");
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(ticker);
    }
  });

  it("keeps a candidate that a span references after the initial blob scan", async () => {
    t = await makeRoots({ noEngine: true });
    const payload = "shared".repeat(8_000);
    const old = hex(16);
    t.roots.ingest([batch([span({ traceId: old, name: "old", kind: "workflow", attrs: [s("payload", payload)] })])]);
    t.roots.store.db.prepare("UPDATE runs SET received_ms = 1, ended_ms = 1, updated_ms = 1 WHERE trace_id = ?").run(old);
    const sha = JSON.parse((t.roots.store.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(old) as { blobs: string }).blobs)[0] as string;
    const swept = t.roots.store.sweepDetached(1, Number.POSITIVE_INFINITY, Date.now());
    const pending = t.roots.store.prepareBlobReclamation(swept.blobCandidates);
    expect(pending.candidates).toEqual([sha]);

    const current = hex(16);
    t.roots.ingest([batch([span({ traceId: current, name: "current", kind: "workflow", attrs: [s("payload", payload)] })])]);
    t.roots.store.reclaimBlobs(pending.candidates, pending.afterSeq);

    expect(t.roots.store.blobs.size()).toBeGreaterThan(0);
    expect(t.roots.store.batchesForTraces([current])[0].spans[0].attributes).toContainEqual(s("payload", payload));
    expect(t.roots.store.getMeta("retention_blob_candidates")).toBe("[]");
  });
});
