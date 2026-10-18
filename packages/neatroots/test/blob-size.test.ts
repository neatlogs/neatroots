import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobStore } from "../src/store/blobs.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-blob-size-"));
  homes.push(dir);
  const blobs = new BlobStore(dir);
  const sha = blobs.put("first");
  const shard = path.join(dir, sha.slice(0, 2));
  const file = path.join(shard, sha.slice(2));
  return { dir, blobs, shard, file };
}

describe("blob retention size during atomic writes", () => {
  it("excludes only recognized writer temporaries and still counts orphan payloads", () => {
    const { blobs, shard, file } = fixture();
    const tmp = `${file}.123.${"a".repeat(32)}.tmp`;
    const legacy = `${file}.123.${"a".repeat(8)}.tmp`;
    fs.writeFileSync(tmp, "replacement");
    fs.writeFileSync(legacy, "legacy replacement");
    fs.writeFileSync(path.join(shard, "orphan.tmp"), "orphan");
    fs.writeFileSync(`${file}.123.short.tmp`, "keep");
    expect(blobs.size()).toBe(Buffer.byteLength("firstorphankeep"));
    expect(fs.existsSync(tmp)).toBe(true); // accounting never deletes interrupted-write artifacts
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it.each([8, 32])("does not double-count or fail when a %i-hex temporary is renamed after enumeration", (digits) => {
    const { blobs, shard, file } = fixture();
    const tmp = `${file}.123.${"b".repeat(digits)}.tmp`;
    fs.writeFileSync(tmp, "replacement");
    const read = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike) => {
      const names = read(target);
      if (String(target) === shard) fs.renameSync(tmp, file);
      return names;
    }) as typeof fs.readdirSync);
    expect(blobs.size()).toBe(Buffer.byteLength("replacement"));
  });

  it("ignores a final payload removed after enumeration", () => {
    const { blobs, file } = fixture();
    const other = blobs.put("surviving payload");
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
      if (String(target) === file) fs.unlinkSync(file);
      return stat(target);
    }) as typeof fs.statSync);
    expect(blobs.size()).toBe(Buffer.byteLength(blobs.get(other)!));
  });

  it.each(["root-read", "shard-stat", "shard-read"])("ignores disappearance during %s", (phase) => {
    const { dir, blobs, shard } = fixture();
    if (phase === "shard-stat") {
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
        if (String(target) === shard) fs.rmSync(shard, { recursive: true });
        return stat(target);
      }) as typeof fs.statSync);
    } else {
      const read = fs.readdirSync;
      const removed = phase === "root-read" ? dir : shard;
      vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike) => {
        if (String(target) === removed) fs.rmSync(removed, { recursive: true });
        return read(target);
      }) as typeof fs.readdirSync);
    }
    expect(blobs.size()).toBe(0);
  });

  it.each(["root-read", "shard-stat", "shard-read", "file-stat"])("preserves real I/O errors during %s", (phase) => {
    const { dir, blobs, shard, file } = fixture();
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const failed = phase === "root-read" ? dir : phase === "file-stat" ? file : shard;
    if (phase.endsWith("stat")) {
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
        if (String(target) === failed) throw error;
        return stat(target);
      }) as typeof fs.statSync);
    } else {
      const read = fs.readdirSync;
      vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike) => {
        if (String(target) === failed) throw error;
        return read(target);
      }) as typeof fs.readdirSync);
    }
    expect(() => blobs.size()).toThrow(error);
  });
});
