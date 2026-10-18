import fs from "node:fs";
import path from "node:path";
import { archiveDirectory, readFile, sha256 } from "./files.js";

export interface Entry {
  seq: number;
  ts: string;
  trace_id: string;
  path: string;
  bundle_sha256: string;
  sidecar_sha256: string;
  prev: string;
  entry_sha256: string;
}

/** Fixed field order, UTF-8, compact JSON, no newline; never hash a reserialized bundle. */
export function entryHash(e: Omit<Entry, "entry_sha256">): string {
  return sha256(JSON.stringify({ seq: e.seq, ts: e.ts, trace_id: e.trace_id, path: e.path,
    bundle_sha256: e.bundle_sha256, sidecar_sha256: e.sidecar_sha256, prev: e.prev }));
}

const genesisFields = { seq: 0, ts: "1970-01-01T00:00:00.000Z", trace_id: "", path: "",
  bundle_sha256: "", sidecar_sha256: "", prev: "0".repeat(64) };
export const GENESIS: Entry = Object.freeze({ ...genesisFields, entry_sha256: entryHash(genesisFields) });
export const line = (e: Entry): Buffer => Buffer.from(JSON.stringify(e) + "\n", "utf8");
const HASH = /^[a-f0-9]{64}$/;
const BUNDLE = /^\d{8,16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/trace\.json$/;

export interface Verification {
  ok: boolean;
  seq: number;
  head: string;
  errors: string[];
  entries: Entry[];
}

/** Read-only: also rejects unlisted files/directories and interrupted publications. */
export function verifyArchive(input: string, expectHead?: string, writer = false): Verification {
  const result: Verification = { ok: false, seq: 0, head: GENESIS.entry_sha256, errors: [], entries: [] };
  const error = (message: string) => { result.errors.push(message); };
  try {
    const dir = archiveDirectory(input);
    const expected = new Set(["manifest.jsonl"]);
    if (writer) expected.add(".writer.lock");
    const text = readFile(path.join(dir, "manifest.jsonl")).toString("utf8");
    if (!text.endsWith("\n")) error("manifest has an interrupted final line");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines[0] !== JSON.stringify(GENESIS)) error("invalid or missing genesis");
    let previous = GENESIS;
    for (let i = 1; i < lines.length; i++) {
      let e: Entry;
      try { e = JSON.parse(lines[i]); } catch { error(`invalid manifest JSON at line ${i + 1}`); break; }
      if (!e || typeof e !== "object" || Object.keys(e).sort().join() !== Object.keys(GENESIS).sort().join()
        || e.seq !== i || !Number.isSafeInteger(e.seq) || typeof e.ts !== "string" || !Number.isFinite(Date.parse(e.ts)) || new Date(e.ts).toISOString() !== e.ts
        || typeof e.trace_id !== "string" || !/^[a-f0-9]{32}$/.test(e.trace_id)
        || typeof e.path !== "string" || !BUNDLE.test(e.path) || !e.path.startsWith(`${String(i).padStart(8, "0")}-`)
        || !HASH.test(e.bundle_sha256) || !HASH.test(e.sidecar_sha256) || !HASH.test(e.entry_sha256)
        || e.prev !== previous.entry_sha256 || e.entry_sha256 !== entryHash(e)) {
        error(`invalid chain entry ${i}`); break;
      }
      const folder = e.path.split("/")[0];
      if (expected.has(folder)) { error(`duplicate bundle path at entry ${i}`); break; }
      expected.add(folder);
      try {
        const bundleDir = archiveDirectory(path.join(dir, folder));
        for (const [name, hash] of [["trace.json", e.bundle_sha256], ["record.json", e.sidecar_sha256]]) {
          if (sha256(readFile(path.join(bundleDir, name))) !== hash) error(`edited artifact: ${folder}/${name}`);
        }
        for (const name of fs.readdirSync(bundleDir)) if (!["trace.json", "record.json"].includes(name)) error(`extra artifact: ${folder}/${name}`);
      } catch (err) { error(`missing or unsafe bundle ${folder}: ${(err as Error).message}`); }
      result.entries.push(e);
      result.seq = e.seq;
      result.head = e.entry_sha256;
      previous = e;
    }
    for (const name of fs.readdirSync(dir)) if (!expected.has(name)) error(`out-of-chain artifact: ${name}`);
  } catch (err) { error((err as Error).message); }
  if (expectHead !== undefined && (!HASH.test(expectHead) || expectHead !== result.head)) error("expected head does not match archive head");
  result.ok = result.errors.length === 0;
  return result;
}
