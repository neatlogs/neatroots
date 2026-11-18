import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobStore } from "../src/store/blobs.js";
import { sha256 } from "../src/util/ids.js";
import { batch, closeTrackedStores, hex, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
const home = () => {
  const h = tmpHome();
  homes.push(h);
  return h;
};
afterEach(() => {
  vi.restoreAllMocks();
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

// Two bytes per character, so a length check on characters would not catch a truncated file.
const payload = `payload ${"é".repeat(40_000)}`;
const fileOf = (dir: string, sha: string) => path.join(dir, sha.slice(0, 2), sha.slice(2));

// A crash, a power cut or a full disk during a write leaves a short file under the right name.
// put() used to see that the file existed and keep it, so the next copy of the same payload
// (an SDK retrying after neatroots came back) was stored truncated, with no error.
describe("BlobStore.put", () => {
  it("stores a payload and reads it back", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    expect(sha).toBe(sha256(payload));
    expect(blobs.get(sha)).toBe(payload);
    expect(blobs.sizeOf(sha)).toBe(Buffer.byteLength(payload, "utf8"));
  });

  it("rewrites a file that an interrupted write left short", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    fs.truncateSync(fileOf(dir, sha), 1000);
    expect(blobs.get(sha)).not.toBe(payload);
    expect(blobs.put(payload)).toBe(sha);
    expect(blobs.get(sha)).toBe(payload);
  });

  it("keeps a complete file as it is", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    const before = fs.statSync(fileOf(dir, sha)).mtimeMs;
    blobs.put(payload);
    expect(fs.statSync(fileOf(dir, sha)).mtimeMs).toBe(before);
  });

  it("leaves nothing under the final name when a write fails partway", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(((file: fs.PathOrFileDescriptor, data: unknown, opts?: fs.WriteFileOptions) => {
      write(file, String(data).slice(0, 100), opts);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }) as typeof fs.writeFileSync);
    const sha = sha256(payload);
    expect(() => blobs.put(payload)).toThrow(/ENOSPC/);
    expect(fs.existsSync(fileOf(dir, sha))).toBe(false);
    expect(fs.readdirSync(path.join(dir, sha.slice(0, 2)))).toEqual([]);
    expect(blobs.put(payload)).toBe(sha);
    expect(blobs.get(sha)).toBe(payload);
  });

  it("leaves no temporary files behind after a normal write", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    expect(fs.readdirSync(path.join(dir, sha.slice(0, 2)))).toEqual([sha.slice(2)]);
  });
});

describe("a span re-sent after an interrupted write", () => {
  it("is stored with its full payload", () => {
    const data = path.join(home(), "data");
    const st = trackedStore(data);
    const send = () => {
      const t = hex(16);
      const sp = span({ traceId: t, name: "big", kind: "tool", attrs: [s("neatlogs.tool.output", payload)] });
      st.ingest([batch([sp])]);
      return { t, sp };
    };
    send();
    const [sha] = JSON.parse((st.db.prepare("SELECT blobs FROM spans").get() as { blobs: string }).blobs) as string[];
    fs.truncateSync(fileOf(path.join(data, "blobs"), sha), 1000);
    const again = send();
    const [back] = st.batchesForTraces([again.t]);
    expect(back.spans[0].attributes).toEqual(again.sp.attributes);
  });
});
