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
    // A file left short by a crash or a full disk has the right name but not the right content.
    // Keep a complete one; rewrite anything else, through a temporary file so the final name
    // only ever points at a whole payload.
    if (this.sizeOf(sha) !== Buffer.byteLength(data, "utf8")) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmp, data, "utf8");
        fs.renameSync(tmp, f);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
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

  /** Total bytes on disk, for retention. */
  size(): number {
    let total = 0;
    if (!fs.existsSync(this.dir)) return 0;
    for (const sub of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, sub);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) total += fs.statSync(path.join(p, f)).size;
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
