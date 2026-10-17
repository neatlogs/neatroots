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
});
