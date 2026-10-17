import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../util/ids.js";
import type { AnyValue, KeyValue } from "../otlp/types.js";

/** String attribute values above this size are stored as blob files beside the database. */
export const BLOB_THRESHOLD = 32 * 1024;

export interface BlobRef {
  blobRef: { sha: string; len: number };
}

/**
 * What a blob reference reads back as when its payload is gone. A store copied without its
 * `blobs/` tree keeps the references and loses the payloads; reading those back as an empty string
 * hides the loss on every surface (the run page, the API, MCP, cloud forward), so a missing payload
 * says so instead.
 */
export function missingPayload(ref: { sha: string; len: number }): string {
  return `[neatroots: payload missing, sha ${ref.sha} (${ref.len} bytes)]`;
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

  get(sha: string): string | undefined {
    try {
      return fs.readFileSync(this.file(sha), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Whether this payload is on disk. `get` cannot tell an empty file from a missing one. */
  has(sha: string): boolean {
    return fs.existsSync(this.file(sha));
  }

  /** Every payload file on disk, as shas. Used to find files nothing references. */
  shas(): string[] {
    const out: string[] = [];
    if (!fs.existsSync(this.dir)) return out;
    for (const sub of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, sub);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) out.push(sub + f);
    }
    return out;
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
    if (ref) return { stringValue: this.get(ref.sha) ?? missingPayload(ref) };
    if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => this.rehydrateValue(x)) } };
    if ("kvlistValue" in v) return { kvlistValue: { values: this.rehydrate(v.kvlistValue.values) } };
    return v;
  }
}
