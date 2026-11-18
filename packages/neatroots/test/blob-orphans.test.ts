import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/util/ids.js";
import { batch, closeTrackedStores, hex, makeRoots, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const hourAgo = (ms = 2 * 3_600_000) => (Date.now() - ms) / 1000;
const put = (dir: string, name: string, data: string, ageMs?: number) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  if (ageMs !== undefined) fs.utimesSync(f, hourAgo(ageMs), hourAgo(ageMs));
  return f;
};
const blobName = (data: string) => {
  const sha = sha256(data);
  return path.join(sha.slice(0, 2), sha.slice(2));
};

// #407: when neatroots is killed mid-ingest, payload files written for batches that never reached
// the database stay in blobs/ for good. Nothing references them, nothing deleted them, and they
// counted toward the retention size cap.
describe("orphaned blob files", () => {
  it("are removed at startup once old enough, and nothing a span references is touched", () => {
    const h = tmpHome();
    homes.push(h);
    const st = trackedStore(path.join(h, "data"));
    const dir = path.join(h, "data", "blobs");
    const big = "kept ".repeat(10_000); // over the blob threshold, so stored as a file
    st.ingest([batch([span({ traceId: hex(16), spanId: hex(8), name: "run", kind: "workflow", attrs: [s("input.value", big)] })])]);
    const referenced = path.join(dir, blobName(big));
    fs.utimesSync(referenced, hourAgo(), hourAgo());
    const orphan = put(dir, blobName("lost in a crash"), "lost in a crash", 2 * 3_600_000);
    const empty = put(dir, blobName("empty"), "", 2 * 3_600_000);
    const tmp = put(dir, `${blobName("half")}.4242.deadbeef.tmp`, "ha", 2 * 3_600_000);
    const fresh = put(dir, blobName("still being written"), "still being written"); // just now
    const stranger = put(dir, "notes/README", "not ours", 2 * 3_600_000);
    const before = st.storedBytes();

    expect(st.reclaimOrphanBlobs()).toEqual({ files: 3, bytes: "lost in a crash".length + "ha".length });
    for (const f of [orphan, empty, tmp]) expect(fs.existsSync(f), f).toBe(false);
    for (const f of [referenced, fresh, stranger]) expect(fs.existsSync(f), f).toBe(true);
    expect(st.storedBytes()).toBeLessThan(before);
    expect(st.reclaimOrphanBlobs()).toEqual({ files: 0, bytes: 0 }); // nothing left to do
  });

  it("are cleaned up when neatroots starts", async () => {
    const t = await makeRoots({ noEngine: true });
    try {
      const dir = path.join(t.roots.home, "data", "blobs");
      const orphan = put(dir, blobName("left by kill -9"), "left by kill -9", 2 * 3_600_000);
      t.roots.startRetention();
      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("doesn't follow a symlinked folder out of blobs/", () => {
    const h = tmpHome();
    homes.push(h);
    const st = trackedStore(path.join(h, "data"));
    const elsewhere = path.join(h, "elsewhere");
    const victim = put(elsewhere, blobName("someone else's file").slice(3), "someone else's file", 2 * 3_600_000);
    const sha = sha256("someone else's file");
    fs.symlinkSync(elsewhere, path.join(h, "data", "blobs", sha.slice(0, 2)));
    expect(st.reclaimOrphanBlobs().files).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("skips a file that disappears while the folder is scanned", () => {
    const h = tmpHome();
    homes.push(h);
    const st = trackedStore(path.join(h, "data"));
    const dir = path.join(h, "data", "blobs");
    const vanishing = put(dir, blobName("vanishing"), "vanishing", 2 * 3_600_000);
    const orphan = put(dir, blobName("orphan"), "orphan", 2 * 3_600_000);
    const real = fs.lstatSync;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (String(p) === vanishing && fs.existsSync(vanishing)) {
        fs.unlinkSync(vanishing);
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return real(p, o);
    }) as typeof fs.lstatSync);
    try {
      expect(st.reclaimOrphanBlobs().files).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(orphan)).toBe(false);
  });
});
