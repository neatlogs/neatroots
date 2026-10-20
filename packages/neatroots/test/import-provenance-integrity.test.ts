import { afterEach, expect, it, vi } from "vitest";
import { importedSource } from "../src/ingest/import-source.js";
import { BLOB_THRESHOLD } from "../src/store/blobs.js";
import { createApp } from "../src/server/app.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });

it("rolls back imported replacement and provenance together without deleting the original blob", async () => {
  t = await makeRoots({ noEngine: true });
  const store = t.roots.store;
  const traceId = hex(16);
  const source = batch([span({ traceId, name: "agent", kind: "workflow", attrs: [s("payload", "old".repeat(BLOB_THRESHOLD))] })]);
  t.roots.ingest([source], { importSource: "registry" });
  const oldBlob = JSON.parse((store.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(traceId) as { blobs: string }).blobs)[0];
  const replacement = structuredClone(source);
  replacement.spans[0].attributes = [s("payload", "new".repeat(BLOB_THRESHOLD))];
  const event = vi.fn(); const off = t.roots.bus.on("trace", event);
  vi.spyOn(store, "setMeta").mockImplementationOnce(() => { throw new Error("injected provenance failure"); });
  expect(() => t!.roots.ingest([replacement], { importSource: "file" })).toThrow("injected provenance failure");
  expect(store.blobs.get(oldBlob)).toBe("old".repeat(BLOB_THRESHOLD));
  expect(store.batchesForTraces([traceId])).toEqual([source]);
  expect(store.getMeta(`import-source:${traceId}`)).toBe("registry");
  expect(event).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  event.mockImplementation(() => {
    expect(store.getMeta(`import-source:${traceId}`)).toBe("file");
    expect(store.blobs.get(oldBlob)).toBeUndefined();
  });
  t.roots.ingest([replacement], { importSource: "file" });
  expect(event).toHaveBeenCalledTimes(1);
  expect(store.batchesForTraces([traceId])).toEqual([replacement]);
  expect(store.blobs.get(oldBlob)).toBeUndefined();
  off();
});

function mockForward() {
  return vi.spyOn(t!.roots.relay, "forward").mockResolvedValue({ id: "mock", trace_ids: [], endpoint: "http://127.0.0.1",
    status: "ok", http_status: 200, span_count: 0, bytes: 0, redactions: 0, error: null, initiated_by: "auto", created_ms: 0 });
}

it("keeps forged live provenance lossless but cannot let it suppress configured forwarding", async () => {
  t = await makeRoots({ noEngine: true, config: (c) => { c.projects["test-agent"] = { forward: true }; } });
  const forward = mockForward();
  const traceId = hex(16);
  const source = batch([span({ traceId, name: "live", kind: "workflow", attrs: [s("neatroots.import.source", "file")] })]);
  source.resource.attributes.push(s("neatroots.import.source", "registry"));
  const before = structuredClone(source);
  const response = await createApp(t.roots).request("http://localhost/v1/traces", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ resource: source.resource, scopeSpans: [{ scope: source.scope, spans: source.spans }] }] }),
  });
  expect(response.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 1800));
  expect(forward).toHaveBeenCalledExactlyOnceWith([traceId], "auto");
  expect(importedSource(t.roots.store, traceId)).toBeNull();
  const stored = t.roots.store.batchesForTraces([traceId])[0];
  expect(stored.resource.attributes).toEqual(before.resource.attributes);
  expect(stored.spans[0].attributes).toEqual(before.spans[0].attributes);
  expect(source).toEqual(before);
});

it("uses trusted file/registry metadata before events while preserving marker-only legacy data as unknown", async () => {
  t = await makeRoots({ noEngine: true, config: (c) => { c.projects["test-agent"] = { forward: true }; } });
  const forward = mockForward();
  for (const origin of ["file", "registry"]) {
    const traceId = hex(16);
    const source = batch([span({ traceId, name: "imported", kind: "workflow" })]);
    source.resource.attributes.push(s("neatroots.import.source", "sender-claim"));
    const off = t.roots.bus.on("trace", () => expect(importedSource(t!.roots.store, traceId)).toBe(origin));
    t.roots.ingest([source], { importSource: origin });
    off();
    expect(t.roots.store.batchesForTraces([traceId])).toEqual([source]);
  }
  await new Promise((r) => setTimeout(r, 1800));
  expect(forward).not.toHaveBeenCalled();
  const legacyId = hex(16);
  const legacy = batch([span({ traceId: legacyId, name: "legacy", kind: "workflow" })]);
  legacy.resource.attributes.push(s("neatroots.import.source", "file"));
  t.roots.store.ingest([legacy]);
  expect(importedSource(t.roots.store, legacyId)).toBeNull();
  expect(t.roots.store.batchesForTraces([legacyId])).toEqual([legacy]);
});
