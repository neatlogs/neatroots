import fs from "node:fs";
import { spawn } from "node:child_process";
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

  it("creates an empty payload and repairs same-length corruption", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const empty = blobs.put("");
    expect(fs.existsSync(fileOf(dir, empty))).toBe(true);
    const sha = blobs.put(payload);
    fs.writeFileSync(fileOf(dir, sha), Buffer.alloc(Buffer.byteLength(payload), 120));
    expect(blobs.put(payload)).toBe(sha);
    expect(blobs.get(sha)).toBe(payload);
  });

  it("propagates existing-file read failures without attempting replacement", () => {
    const blobs = new BlobStore(path.join(home(), "blobs"));
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw error; });
    const open = vi.spyOn(fs, "openSync");
    expect(() => blobs.put(payload)).toThrow(error);
    expect(open).not.toHaveBeenCalled();
  });

  it("preserves the old final and original error when replacement and cleanup fail", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    fs.writeFileSync(fileOf(dir, sha), "old");
    const error = Object.assign(new Error("rename denied"), { code: "EACCES" });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw error; });
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("cleanup denied"); });
    expect(() => blobs.put(payload)).toThrow(error);
    expect(fs.readFileSync(fileOf(dir, sha), "utf8")).toBe("old");
  });

  it("never removes a temporary file it could not exclusively create", () => {
    const blobs = new BlobStore(path.join(home(), "blobs"));
    const error = Object.assign(new Error("collision"), { code: "EEXIST" });
    const realOpen = fs.openSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
      if (flags === "wx") throw error;
      return realOpen(file, flags, mode);
    }) as typeof fs.openSync);
    const remove = vi.spyOn(fs, "rmSync");
    expect(() => blobs.put(payload)).toThrow(error);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), "wx");
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps the previous final when a replacement write runs out of space", () => {
    const dir = path.join(home(), "blobs");
    const blobs = new BlobStore(dir);
    const sha = blobs.put(payload);
    fs.writeFileSync(fileOf(dir, sha), "old");
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(((file, data, opts) => {
      write(file, Buffer.from(data as Uint8Array).subarray(0, 10), opts);
      throw error;
    }) as typeof fs.writeFileSync);
    expect(() => blobs.put(payload)).toThrow(error);
    expect(fs.readFileSync(fileOf(dir, sha), "utf8")).toBe("old");
    expect(fs.readdirSync(path.dirname(fileOf(dir, sha)))).toEqual([sha.slice(2)]);
  });

  it("publishes complete identical payloads from concurrent processes", async () => {
    const dir = path.join(home(), "blobs");
    const source = new URL("../src/store/blobs.ts", import.meta.url).href;
    const script = `import { BlobStore } from ${JSON.stringify(source)};
      const store = new BlobStore(${JSON.stringify(dir)});
      for (let i = 0; i < 8; i++) store.put("payload " + "\u00e9".repeat(40000));`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
    })));
    const sha = sha256(payload);
    expect(new BlobStore(dir).get(sha)).toBe(payload);
    expect(fs.readdirSync(path.dirname(fileOf(dir, sha)))).toEqual([sha.slice(2)]);
  }, 20_000);

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
