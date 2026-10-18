import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Roots } from "../core.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import { compileRules, redactBatches, type RedactionHit } from "../relay/redact.js";
import { archiveDirectory, atomicFile, readFile, sha256, syncDirectory } from "./files.js";
import { entryHash, GENESIS, line, verifyArchive, type Entry } from "./manifest.js";
import { importedSource } from "../ingest/import-source.js";
import { redactRecord } from "./redact-record.js";

interface Snapshot { trace: Buffer; record: Buffer }
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");

/** Resolve existing ancestors too: aliases/case variants must not publish shares into originals. */
export function comparisonDirectory(directory: string): string {
  let ancestor = directory;
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`archive filesystem root does not exist or is inaccessible: ${ancestor}; choose an accessible directory`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const resolved = path.join(fs.realpathSync.native(ancestor), ...suffix);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Keep OTLP IDs, int64 strings, typed values and all stored resource/scope/span fields. */
export function traceJson(batches: ResourceSpansBatch[]): object {
  return { resourceSpans: batches.map((b) => {
    const { schemaUrl: resourceSchema, ...resource } = b.resource;
    const { schemaUrl: scopeSchema, ...scope } = b.scope;
    return { resource, schemaUrl: resourceSchema, scopeSpans: [{ scope, schemaUrl: scopeSchema, spans: b.spans }] };
  }) };
}

export function snapshot(roots: Roots, traceId: string): Snapshot {
  return roots.store.db.transaction(() => {
    const run = roots.store.getRun(traceId);
    if (!run) throw new Error("run not found");
    // This baseline's general read path turns missing blobs into empty strings. Archives must not.
    const refs = roots.store.db.prepare("SELECT DISTINCT j.value AS sha FROM spans, json_each(spans.blobs) j WHERE trace_id = ? AND spans.blobs IS NOT NULL").all(traceId) as { sha: string }[];
    for (const { sha } of refs) {
      const payload = roots.store.blobs.get(sha);
      if (payload === undefined || sha256(payload) !== sha) throw new Error(`missing or corrupt payload: ${sha}`);
    }
    const explanations = roots.store.db.prepare("SELECT id FROM explanations WHERE trace_id = ? ORDER BY created_ms, id").all(traceId) as { id: string }[];
    return {
      trace: json(traceJson(roots.store.batchesForTraces([traceId]))),
      record: json({ format: "neatroots-audit-record-v1", trace_id: traceId, run,
        findings: roots.store.findingsForTrace(traceId), decisions: roots.store.decisionsForTrace(traceId),
        explanations: explanations.map(({ id }) => roots.store.getExplanation(id)),
        summary: roots.store.getSummary(traceId) ?? null, annotations: roots.store.annotationsForTrace(traceId),
        import_source: importedSource(roots.store, traceId) }),
    };
  })();
}

/** Synchronous critical section: no await between snapshot, exclusive publication and append. */
function append(directory: string, traceId: string, data: Snapshot): Entry {
  const dir = archiveDirectory(directory, true);
  const lock = path.join(dir, ".writer.lock");
  const lockFd = fs.openSync(lock, "wx", 0o600);
  try {
    let previous = GENESIS;
    if (fs.readdirSync(dir).every((name) => name === ".writer.lock")) {
      atomicFile(path.join(dir, "manifest.jsonl"), line(GENESIS));
    } else {
      const verified = verifyArchive(dir, undefined, true);
      if (!verified.ok) throw new Error(`archive verification failed: ${verified.errors.join("; ")}`);
      previous = verified.entries.at(-1) ?? GENESIS;
    }
    const seq = previous.seq + 1;
    const folder = `${String(seq).padStart(8, "0")}-${crypto.randomUUID()}`;
    const target = path.join(dir, folder);
    fs.mkdirSync(target, { mode: 0o700 });
    syncDirectory(dir);
    atomicFile(path.join(target, "trace.json"), data.trace);
    atomicFile(path.join(target, "record.json"), data.record);
    const fields = { seq, ts: new Date().toISOString(), trace_id: traceId, path: `${folder}/trace.json`,
      bundle_sha256: sha256(data.trace), sidecar_sha256: sha256(data.record), prev: previous.entry_sha256 };
    const entry = { ...fields, entry_sha256: entryHash(fields) };
    const manifest = path.join(dir, "manifest.jsonl");
    const fd = fs.openSync(manifest, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) throw new Error("unsafe manifest");
      fs.writeFileSync(fd, line(entry));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(dir);
    return entry;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
    syncDirectory(dir);
  }
}

export interface ExportOptions { directory?: string; redacted?: boolean; output?: string; preview?: boolean; preview_token?: string }

export class AuditArchive {
  constructor(private readonly roots: Roots) {}

  /** Verify exact current bytes before release; unchanged originals reuse their last entry. */
  ensure(traceId: string, directory: string) {
    const data = snapshot(this.roots, traceId);
    const dir = archiveDirectory(directory, true);
    let verified = fs.readdirSync(dir).length ? verifyArchive(dir) : undefined;
    if (verified && !verified.ok) throw new Error(`archive verification failed: ${verified.errors.join("; ")}`);
    const prior = verified?.entries.findLast((e) => e.trace_id === traceId);
    if (prior?.bundle_sha256 === sha256(data.trace) && prior.sidecar_sha256 === sha256(data.record)) return prior;
    const entry = append(directory, traceId, data);
    verified = verifyArchive(directory, entry.entry_sha256);
    if (!verified.ok) throw new Error(`archive verification failed: ${verified.errors.join("; ")}`);
    return entry;
  }

  export(traceId: string, options: ExportOptions = {}) {
    if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("trace_id must be 32 lowercase hexadecimal characters");
    const directory = options.directory ?? path.join(this.roots.home, "audit");
    if (!options.redacted) {
      if (options.output || options.preview || options.preview_token) throw new Error("preview/output options require redacted export");
      const entry = append(directory, traceId, snapshot(this.roots, traceId));
      return { seq: entry.seq, head: entry.entry_sha256, directory: path.resolve(directory), path: entry.path, redacted: false };
    }
    const verified = verifyArchive(directory);
    if (!verified.ok) throw new Error(`archive verification failed: ${verified.errors.join("; ")}`);
    const entry = verified.entries.findLast((e) => e.trace_id === traceId);
    if (!entry) throw new Error("export an original archive for this run before making a redacted share copy");
    const original = path.join(directory, path.dirname(entry.path));
    const trace = JSON.parse(readFile(path.join(original, "trace.json")).toString("utf8"));
    const record = JSON.parse(readFile(path.join(original, "record.json")).toString("utf8"));
    // Decode only our own verified OTLP, using the same redaction behavior as cloud forwarding.
    const batches: ResourceSpansBatch[] = trace.resourceSpans.flatMap((r: any) => r.scopeSpans.map((s: any) => ({
      resource: { ...r.resource, schemaUrl: r.schemaUrl }, scope: { ...s.scope, schemaUrl: s.schemaUrl }, spans: s.spans,
    })));
    const rules = compileRules(this.roots.config.cloud.redactPatterns);
    const redacted = redactBatches(batches, rules);
    const hits: RedactionHit[] = [...redacted.hits];
    const data = { trace: json(traceJson(redacted.batches)), record: json({ redacted: true, source_entry_sha256: entry.entry_sha256, record: redactRecord(record, rules, hits) }) };
    const token = sha256(Buffer.concat([data.trace, data.record]));
    const preview = { seq: verified.seq, head: verified.head, redacted: true, preview_token: token,
      span_count: batches.reduce((n, b) => n + b.spans.length, 0), redactions: hits };
    if (options.preview) return preview;
    if (options.preview_token !== token) throw new Error("a current redaction preview token is required");
    if (!options.output) throw new Error("redacted share export requires a separate output directory");
    const source = path.resolve(directory), output = path.resolve(options.output);
    const sourceKey = comparisonDirectory(source), outputKey = comparisonDirectory(output);
    if (outputKey === sourceKey || outputKey.startsWith(sourceKey + path.sep) || sourceKey.startsWith(outputKey + path.sep)) {
      throw new Error("share output must be separate from the original archive");
    }
    const shared = append(output, traceId, data);
    return { ...preview, seq: shared.seq, head: shared.entry_sha256, directory: output, path: shared.path };
  }
}
