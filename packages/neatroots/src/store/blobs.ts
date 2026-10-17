import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../util/ids.js";
import type { AnyValue, KeyValue } from "../otlp/types.js";

/** String attribute values above this size are stored as blob files beside the database. */
export const BLOB_THRESHOLD = 32 * 1024;

export interface BlobRef {
  blobRef: { sha: string; len: number };
}

export type BlobReadErrorKind = "missing" | "corrupt" | "unreadable";

export class BlobReadError extends Error {
  constructor(
    readonly kind: BlobReadErrorKind,
    readonly sha: string,
    cause?: unknown,
  ) {
    super(`Stored blob ${sha} is ${kind}.`, cause === undefined ? undefined : { cause });
    this.name = "BlobReadError";
  }
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
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data, "utf8");
    }
    return sha;
  }

  get(ref: BlobRef["blobRef"]): string {
    const { sha, len } = ref;
    if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isSafeInteger(len) || len < 0) throw new BlobReadError("corrupt", sha);
    let value: string;
    try {
      value = fs.readFileSync(this.file(sha), "utf8");
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
      if (code === "ENOENT") throw new BlobReadError("missing", sha, cause);
      if (code === "ENOTDIR" || code === "EISDIR") throw new BlobReadError("corrupt", sha, cause);
      throw new BlobReadError("unreadable", sha, cause);
    }
    if (value.length !== len || sha256(value) !== sha) throw new BlobReadError("corrupt", sha);
    return value;
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
    const ref = (v as unknown as { blobRef?: unknown }).blobRef;
    if (ref !== undefined) {
      if (typeof ref !== "object" || ref === null) throw new BlobReadError("corrupt", "invalid");
      const sha = "sha" in ref && typeof ref.sha === "string" ? ref.sha : "invalid";
      const len = "len" in ref ? ref.len : undefined;
      if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0) throw new BlobReadError("corrupt", sha);
      return { stringValue: this.get({ sha, len }) };
    }
    if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => this.rehydrateValue(x)) } };
    if ("kvlistValue" in v) return { kvlistValue: { values: this.rehydrate(v.kvlistValue.values) } };
    return v;
  }
}
