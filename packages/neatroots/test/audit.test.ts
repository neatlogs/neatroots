import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditArchive } from "../src/audit/archive.js";
import { atomicFile, sha256 } from "../src/audit/files.js";
import { entryHash, GENESIS, verifyArchive } from "../src/audit/manifest.js";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

const roots: TestRoots[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const t of roots.splice(0)) await t.close(); });

async function fixture() {
  const t = await makeRoots({ noEngine: true }); roots.push(t);
  const traceId = hex(16);
  const original = batch([span({ traceId, name: "agent", kind: "workflow", attrs: [
    s("payload", "original-".repeat(9000)),
    { key: "int64", value: { intValue: "9223372036854775807" } },
    { key: "bytes", value: { bytesValue: "AAECA/8=" } },
    { key: "nested", value: { kvlistValue: { values: [{ key: "a", value: { arrayValue: { values: [{ doubleValue: 1.25 }, { boolValue: true }] } } }] } } },
  ] })]);
  original.resource.schemaUrl = "https://example.test/resource-schema";
  original.resource.droppedAttributesCount = 3;
  original.scope.schemaUrl = "https://example.test/scope-schema";
  original.scope.version = "1.2";
  original.scope.droppedAttributesCount = 2;
  original.scope.attributes = [s("scope-attr", "kept")];
  Object.assign(original.spans[0], { traceState: "vendor=state", flags: 3, droppedAttributesCount: 2,
    droppedEventsCount: 1, droppedLinksCount: 2,
    events: [{ name: "event", timeUnixNano: "1234567890123456789", attributes: [s("event", "kept")], droppedAttributesCount: 4 }],
    links: [{ traceId: hex(16), spanId: hex(8), traceState: "other=value", attributes: [s("link", "kept")], flags: 1, droppedAttributesCount: 5 }] });
  t.roots.ingest([original]);
  const archive = new AuditArchive(t.roots);
  const directory = path.join(t.roots.home, "audit");
  return { t, traceId, original, archive, directory };
}

describe("audit archives", () => {
  it("hashes exact written bytes, preserves all stored OTLP and appends immutable versions", async () => {
    const f = await fixture();
    const first = f.archive.export(f.traceId);
    const raw = fs.readFileSync(path.join(f.directory, first.path!));
    const verified = verifyArchive(f.directory, first.head);
    expect(verified.ok).toBe(true);
    expect(verified.entries[0].bundle_sha256).toBe(sha256(raw));
    expect(verified.entries[0].prev).toBe(GENESIS.entry_sha256);
    expect(verified.entries[0].entry_sha256).toBe(entryHash(verified.entries[0]));
    expect(parseTraceFile(raw.toString(), "trace.json")).toEqual([f.original]);
    f.t.roots.ingest([batch([span({ traceId: f.traceId, name: "late", kind: "tool" })])]);
    const second = f.archive.export(f.traceId);
    expect(second.seq).toBe(2);
    expect(second.head).not.toBe(first.head);
    expect(fs.readFileSync(path.join(f.directory, first.path!))).toEqual(raw);
    expect(verifyArchive(f.directory, second.head).ok).toBe(true);
    expect(verifyArchive(f.directory, first.head).ok).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(f.directory).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(f.directory, first.path!)).mode & 0o077).toBe(0);
    }
  });

  it.each(["trace.json", "record.json"])("detects edits and missing %s", async (name) => {
    const f = await fixture(); const entry = f.archive.export(f.traceId);
    const file = path.join(f.directory, path.dirname(entry.path!), name);
    fs.appendFileSync(file, " ");
    expect(verifyArchive(f.directory).errors.join()).toContain("edited artifact");
    fs.unlinkSync(file);
    expect(verifyArchive(f.directory).errors.join()).toContain("missing or unsafe");
    expect(() => f.archive.export(f.traceId)).toThrow(/verification failed/);
  });

  it("finds extra/out-of-chain artifacts and externally anchored tail removal or rewriting", async () => {
    const f = await fixture(); const first = f.archive.export(f.traceId); const second = f.archive.export(f.traceId);
    const manifest = path.join(f.directory, "manifest.jsonl");
    const text = fs.readFileSync(manifest, "utf8");
    fs.writeFileSync(path.join(f.directory, "extra.json"), "{}");
    expect(verifyArchive(f.directory).errors.join()).toContain("out-of-chain");
    fs.unlinkSync(path.join(f.directory, "extra.json"));
    fs.writeFileSync(path.join(f.directory, path.dirname(first.path!), "extra"), "");
    expect(verifyArchive(f.directory).errors.join()).toContain("extra artifact");
    fs.unlinkSync(path.join(f.directory, path.dirname(first.path!), "extra"));
    fs.writeFileSync(manifest, text.split("\n").slice(0, 2).join("\n") + "\n");
    expect(verifyArchive(f.directory).errors.join()).toContain("out-of-chain");
    fs.rmSync(path.join(f.directory, path.dirname(second.path!)), { recursive: true });
    expect(verifyArchive(f.directory).ok).toBe(true); // No external checkpoint can prove a removed tail.
    expect(verifyArchive(f.directory, second.head).errors).toContain("expected head does not match archive head");
    const lines = fs.readFileSync(manifest, "utf8").trimEnd().split("\n");
    const rewritten = JSON.parse(lines[1]); rewritten.ts = "2000-01-01T00:00:00.000Z";
    rewritten.entry_sha256 = entryHash(rewritten); lines[1] = JSON.stringify(rewritten);
    fs.writeFileSync(manifest, lines.join("\n") + "\n");
    expect(verifyArchive(f.directory).ok).toBe(true);
    expect(verifyArchive(f.directory, first.head).ok).toBe(false);
  });

  it("rejects broken genesis, sequence, previous hash, hash and path without following paths", async () => {
    const f = await fixture(); f.archive.export(f.traceId);
    const manifest = path.join(f.directory, "manifest.jsonl"); const original = fs.readFileSync(manifest, "utf8");
    for (const update of [{ seq: 4 }, { prev: "f".repeat(64) }, { path: "../outside/trace.json" }, { entry_sha256: "0".repeat(64) }]) {
      const lines = original.trimEnd().split("\n"); const e = { ...JSON.parse(lines[1]), ...update };
      lines[1] = JSON.stringify(e); fs.writeFileSync(manifest, lines.join("\n") + "\n");
      expect(verifyArchive(f.directory).ok).toBe(false);
    }
    fs.writeFileSync(manifest, original.replace('1970', '1980'));
    expect(verifyArchive(f.directory).errors.join()).toContain("genesis");
    fs.writeFileSync(manifest, original.slice(0, -1));
    expect(verifyArchive(f.directory).errors.join()).toContain("interrupted final line");
  });

  it.skipIf(process.platform === "win32")("refuses traversal, symlinks, hardlinks and unrelated files without overwriting", async () => {
    const f = await fixture();
    const other = path.join(f.t.roots.home, "other"); fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(path.join(other, "keep"), "unrelated");
    expect(() => f.archive.export(f.traceId, { directory: other })).toThrow(/verification failed/);
    expect(fs.readFileSync(path.join(other, "keep"), "utf8")).toBe("unrelated");
    expect(() => f.archive.export(f.traceId, { directory: path.join(f.t.roots.home, "x", "..", "other") + "/../bad" })).toThrow(/invalid/);
    expect(() => f.archive.export("../bad")).toThrow(/trace_id/);
    const first = f.archive.export(f.traceId);
    const link = path.join(f.t.roots.home, "link"); fs.symlinkSync(f.directory, link, "junction");
    expect(() => f.archive.export(f.traceId, { directory: link })).toThrow(/unsafe/);
    expect(verifyArchive(link).ok).toBe(false);
    const file = path.join(f.directory, first.path!); const copy = file + ".outside";
    fs.renameSync(file, copy); fs.symlinkSync(copy, file);
    expect(verifyArchive(f.directory).ok).toBe(false);
    fs.unlinkSync(file); fs.linkSync(copy, file);
    expect(verifyArchive(f.directory).ok).toBe(false);
    const dest = path.join(other, "keep");
    expect(() => atomicFile(dest, Buffer.from("replacement"))).toThrow();
    expect(fs.readFileSync(dest, "utf8")).toBe("unrelated");
  });

  it("fails closed after interrupted file/manifest writes, preserving previous entries", async () => {
    const f = await fixture(); const first = f.archive.export(f.traceId);
    const manifest = path.join(f.directory, "manifest.jsonl"); const before = fs.readFileSync(manifest);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("injected power failure"); });
    expect(() => f.archive.export(f.traceId)).toThrow(/power failure/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(manifest)).toEqual(before);
    expect(verifyArchive(f.directory, first.head).ok).toBe(false);
    expect(() => f.archive.export(f.traceId)).toThrow(/verification failed/);
  });

  it("reports an interrupted manifest append and never appends past it", async () => {
    const f = await fixture(); const first = f.archive.export(f.traceId);
    const originalWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (Buffer.isBuffer(data) && data.toString().startsWith('{"seq":2,')) {
        originalWrite(file, data.subarray(0, 20), options);
        throw new Error("interrupted manifest append");
      }
      originalWrite(file, data, options);
    });
    expect(() => f.archive.export(f.traceId)).toThrow(/interrupted manifest/);
    vi.restoreAllMocks();
    const report = verifyArchive(f.directory, first.head);
    expect(report.ok).toBe(false);
    expect(report.errors.join()).toContain("interrupted final line");
    expect(() => f.archive.export(f.traceId)).toThrow(/verification failed/);
  });

  it("rejects an existing writer lock and missing/corrupt payloads; verification creates nothing", async () => {
    const f = await fixture(); const nonexistent = path.join(f.t.roots.home, "missing");
    expect(verifyArchive(nonexistent).ok).toBe(false); expect(fs.existsSync(nonexistent)).toBe(false);
    f.archive.export(f.traceId); const lock = path.join(f.directory, ".writer.lock"); fs.writeFileSync(lock, "owner");
    expect(() => f.archive.export(f.traceId)).toThrow(); expect(fs.readFileSync(lock, "utf8")).toBe("owner");
    fs.unlinkSync(lock);
    const row = f.t.roots.store.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(f.traceId) as { blobs: string };
    const [sha] = JSON.parse(row.blobs); f.t.roots.store.blobs.delete(sha);
    expect(() => f.archive.export(f.traceId)).toThrow(/missing or corrupt payload/);
    expect(verifyArchive(f.directory).ok).toBe(true);
  });
});
