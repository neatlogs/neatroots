import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobReadError, BlobStore, type BlobReadErrorKind, type BlobRef } from "../src/store/blobs.js";
import { Store } from "../src/store/db.js";
import { batch, hex, makeRoots, s, span, tmpHome } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function blobFixture() {
  const home = tmpHome();
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const blobs = new BlobStore(path.join(home, "data", "blobs"));
  const payload = `large payload ${"x".repeat(40_000)}`;
  const stored = blobs.offload([{ key: "payload", value: { stringValue: payload } }], new Set());
  const ref = (stored[0].value as unknown as BlobRef).blobRef;
  const file = path.join(home, "data", "blobs", ref.sha.slice(0, 2), ref.sha.slice(2));
  return { blobs, file, payload, ref, stored };
}

function expectBlobError(read: () => unknown, kind: BlobReadErrorKind, sha: string): void {
  let error: unknown;
  try {
    read();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BlobReadError);
  expect(error).toMatchObject({ kind, sha });
}

async function storeLargePayload(roots: Awaited<ReturnType<typeof makeRoots>>) {
  const traceId = hex(16);
  const payload = `payload ${"z".repeat(40_000)}`;
  roots.roots.ingest([batch([span({ traceId, name: "large", kind: "tool", attrs: [s("neatlogs.tool.output", payload)] })])]);
  const row = roots.roots.store.db.prepare("SELECT attributes FROM spans WHERE trace_id = ?").get(traceId) as { attributes: string };
  const attrs = JSON.parse(row.attributes) as { key: string; value: { blobRef?: { sha: string; len: number } } }[];
  const ref = attrs.find((a) => a.key === "neatlogs.tool.output")!.value.blobRef!;
  const file = path.join(roots.roots.home, "data", "blobs", ref.sha.slice(0, 2), ref.sha.slice(2));
  return { file, ref, traceId };
}

describe("blob read errors", () => {
  it("distinguishes a missing referenced blob", () => {
    const f = blobFixture();
    fs.unlinkSync(f.file);
    expectBlobError(() => f.blobs.rehydrate(f.stored), "missing", f.ref.sha);
  });

  it("distinguishes a corrupt referenced blob by its content hash", () => {
    const f = blobFixture();
    fs.writeFileSync(f.file, "y".repeat(f.payload.length), "utf8");
    expectBlobError(() => f.blobs.rehydrate(f.stored), "corrupt", f.ref.sha);
  });

  it("distinguishes a corrupted blob path from a missing blob", () => {
    const f = blobFixture();
    const prefixDir = path.dirname(f.file);
    fs.rmSync(prefixDir, { recursive: true });
    fs.writeFileSync(prefixDir, "not a blob directory", "utf8");
    expectBlobError(() => f.blobs.rehydrate(f.stored), "corrupt", f.ref.sha);
  });

  it("distinguishes an unreadable referenced blob", () => {
    const f = blobFixture();
    const original = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync");
    readSpy.mockImplementation((...args) => {
      if (String(args[0]) === f.file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return Reflect.apply(original, fs, args);
    });
    try {
      expectBlobError(() => f.blobs.rehydrate(f.stored), "unreadable", f.ref.sha);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("keeps a partial search reindex incomplete and retries after a blob is restored", async () => {
    const home = tmpHome();
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const store = new Store(path.join(home, "data"));
    cleanups.push(() => store.close());
    const missingTraceId = hex(16);
    const intactTraceId = hex(16);
    const missingPayload = `missing_reindex_token ${"m".repeat(40_000)}`;
    const intactPayload = `intact_reindex_token ${"i".repeat(40_000)}`;
    store.ingest([
      batch([span({ traceId: missingTraceId, name: "missing", kind: "tool", attrs: [s("neatlogs.tool.output", missingPayload)] })]),
      batch([span({ traceId: intactTraceId, name: "intact", kind: "tool", attrs: [s("neatlogs.tool.output", intactPayload)] })]),
    ]);
    const row = store.db.prepare("SELECT attributes FROM spans WHERE trace_id = ?").get(missingTraceId) as { attributes: string };
    const attrs = JSON.parse(row.attributes) as { key: string; value: { blobRef?: { sha: string; len: number } } }[];
    const ref = attrs.find((a) => a.key === "neatlogs.tool.output")!.value.blobRef!;
    const blobFile = path.join(home, "data", "blobs", ref.sha.slice(0, 2), ref.sha.slice(2));
    const exactBlob = fs.readFileSync(blobFile);

    store.db.prepare("DELETE FROM span_fts").run();
    store.db.prepare("DELETE FROM meta WHERE key = 'search_index'").run();
    fs.unlinkSync(blobFile);

    const partial = await new Promise<{ indexed: number; skipped: number; complete: boolean }>((resolve) => store.reindexSearch(resolve));
    expect(partial).toEqual({ indexed: 1, skipped: 1, complete: false });
    expect(store.getMeta("search_index")).toBeUndefined();
    expect(store.searchSpans("intact_reindex_token").map((hit) => hit.trace_id)).toEqual([intactTraceId]);
    expect(store.searchSpans("missing_reindex_token")).toEqual([]);

    fs.writeFileSync(blobFile, exactBlob);
    const retried = await new Promise<{ indexed: number; skipped: number; complete: boolean }>((resolve) => store.reindexSearch(resolve));
    expect(retried).toEqual({ indexed: 2, skipped: 0, complete: true });
    expect(store.getMeta("search_index")).toBeDefined();
    expect(store.searchSpans("missing_reindex_token").map((hit) => hit.trace_id)).toEqual([missingTraceId]);
    expect(store.searchSpans("intact_reindex_token").map((hit) => hit.trace_id)).toEqual([intactTraceId]);
  });

  it("returns a typed HTTP error for a damaged run and keeps serving", async () => {
    const roots = await makeRoots({ serve: true, noEngine: true });
    cleanups.push(roots.close);
    const fixture = await storeLargePayload(roots);
    fs.unlinkSync(fixture.file);

    const response = await fetch(`${roots.url}/api/runs/${fixture.traceId}/chat`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "stored_payload_unavailable",
      reason: "missing",
      sha: fixture.ref.sha,
    });
    expect((await fetch(`${roots.url}/health`)).status).toBe(200);
  });

  it("records a failed forward and sends no request when a payload blob is missing", async () => {
    const roots = await makeRoots({ noEngine: true });
    cleanups.push(roots.close);
    const fixture = await storeLargePayload(roots);
    fs.unlinkSync(fixture.file);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const row = await roots.roots.relay.forward([fixture.traceId], "test", {
        endpoint: "http://127.0.0.1:1",
        apiKey: "nl-test-key",
      });
      expect(row.status).toBe("error");
      expect(row.error).toContain("missing");
      expect(row.error).toContain(fixture.ref.sha);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(roots.roots.store.forwardedTraceIds().has(fixture.traceId)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
