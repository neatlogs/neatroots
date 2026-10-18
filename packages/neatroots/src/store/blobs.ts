import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../util/ids.js";
import type { AnyValue, KeyValue } from "../otlp/types.js";

/** String attribute values above this size are stored as blob files beside the database. */
export const BLOB_THRESHOLD = 32 * 1024;

export interface BlobRef {
  blobRef: { sha: string; len: number };
}

export class BlobStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(sha: string): string {
    return path.join(this.dir, sha.slice(0, 2), sha.slice(2));
  }

  put(data: string): string {
    const sha = sha256(data);
    const f = this.file(sha);
    const bytes = Buffer.from(data, "utf8");
    try {
      // Verify content as well as length: an intact pathname is not proof of an intact write.
      if (fs.readFileSync(f).equals(bytes)) return sha;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
    // Exclusive creation prevents cleanup from removing another writer's temporary file.
    let fd: number | undefined = fs.openSync(tmp, "wx");
    try {
      fs.writeFileSync(fd, bytes);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, f);
    } catch (err) {
      // Cleanup is best effort; the caller must see the original persistence failure.
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* preserve original error */ }
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave an orphan for separate recovery */ }
      throw err;
    }
    return sha;
  }

  get(sha: string): string | undefined {
    try {
      return fs.readFileSync(this.file(sha), "utf8");
    } catch {
      return undefined;
    }
  }

  delete(sha: string): void {
    try {
      fs.unlinkSync(this.file(sha));
    } catch {
      /* already gone */
    }
  }

  /** Bytes of one blob on disk, 0 when it's missing. */
  sizeOf(sha: string): number {
    try {
      return fs.statSync(this.file(sha)).size;
    } catch {
      return 0;
    }
  }

  /** Blob payload bytes for retention, excluding atomic writers' temporary files. */
  size(): number {
    let total = 0;
    let shards: string[];
    try {
      shards = fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return 0;
    }
    for (const sub of shards) {
      const p = path.join(this.dir, sub);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        for (const f of fs.readdirSync(p)) {
          // Recognize current and legacy atomic writers, not arbitrary orphan .tmp files.
          if (/^[a-f0-9]{62}\.[1-9]\d*\.(?:[a-f0-9]{8}|[a-f0-9]{32})\.tmp$/.test(f)) continue;
          try {
            total += fs.statSync(path.join(p, f)).size;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
      } catch (err) {
        // Retention/deletion can remove a shard between enumeration, stat and readdir.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return total;
  }

  /** Replaces large string values with blob references; returns the shas used. */
  offload(kvs: KeyValue[], used: Set<string>): KeyValue[] {
    return kvs.map((kv) => ({ key: kv.key, value: this.offloadValue(kv.value, used) }));
  }

  private offloadValue(v: AnyValue, used: Set<string>): AnyValue {
    if ("stringValue" in v && v.stringValue.length > BLOB_THRESHOLD) {
      const sha = this.put(v.stringValue);
      used.add(sha);
      return { blobRef: { sha, len: v.stringValue.length } } as unknown as AnyValue;
    }
    if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => this.offloadValue(x, used)) } };
    if ("kvlistValue" in v) return { kvlistValue: { values: this.offload(v.kvlistValue.values, used) } };
    return v;
  }

  /** Restores blob references to their original strings. */
  rehydrate(kvs: KeyValue[]): KeyValue[] {
    return kvs.map((kv) => ({ key: kv.key, value: this.rehydrateValue(kv.value) }));
  }

  private rehydrateValue(v: AnyValue): AnyValue {
    const ref = (v as unknown as BlobRef).blobRef;
    if (ref) return { stringValue: this.get(ref.sha) ?? "" };
    if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => this.rehydrateValue(x)) } };
    if ("kvlistValue" in v) return { kvlistValue: { values: this.rehydrate(v.kvlistValue.values) } };
    return v;
  }
}
