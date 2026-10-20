import fs from "node:fs";
import path from "node:path";
import type { Roots } from "../core.js";
import type { RunRow } from "../types.js";
import { buildView } from "../semantics/view.js";
import { kvToPlain } from "../otlp/types.js";
import { projectSettings } from "../config.js";
import { ArchiveUnavailableError, AuditArchive, snapshot } from "./archive.js";
import { readFile, sha256 } from "./files.js";
import { verifyArchive } from "./manifest.js";
import { log } from "../util/log.js";

/** Server-owned archive-before-release policy with bounded synchronous background capture. */
export class AuditHold {
  private readonly archive: AuditArchive;
  private readonly pending = new Set<string>();
  private readonly periodic = new Set<string>();
  private timer?: NodeJS.Timeout;
  private cursor = "";
  private readonly failures = new Map<string, string>();
  private sweep?: { archiveFailed: boolean };
  private readonly unsubscribe: (() => void)[] = [];
  private readonly interval: NodeJS.Timeout;

  constructor(private readonly roots: Roots) {
    this.archive = new AuditArchive(roots);
    this.unsubscribe.push(roots.bus.on("trace", (u) => this.schedule(u.traceId)));
    for (const event of ["finding", "explanation", "summary"] as const) {
      this.unsubscribe.push(roots.bus.on(event, (u) => this.schedule(u.trace_id)));
    }
    this.unsubscribe.push(roots.bus.on("settings", () => { this.cursor = ""; this.scheduleAll(); }));
    // Also covers restart, retries, and edits which have no bus notification (e.g. annotations).
    this.interval = setInterval(() => this.scheduleAll(), 30_000);
    this.interval.unref();
    this.scheduleAll();
  }

  directory(): string { return this.roots.config.audit.directory || path.join(this.roots.home, "audit"); }

  covered(run: RunRow): boolean {
    if (run.doctor || !run.project || !projectSettings(this.roots.config, run.project).audit) return false;
    // The store labels missing project information "unknown". An explicitly named
    // project "unknown" is still configurable; distinguish it using original telemetry.
    if (run.project !== "unknown") return true;
    return this.roots.store.batchesForTraces([run.trace_id]).some(b =>
      kvToPlain(b.resource.attributes)["service.name"] != null || b.spans.some(s => !!buildView(s, b.resource.attributes).workflow));
  }

  private reason(run: RunRow): string | undefined {
    if (!run.complete && !run.root_ended) return "run has not ended";
    if (!this.roots.engine) return "check engine unavailable";
    if (!this.roots.engine.auditReady(run.trace_id)) return "checks are pending or interrupted";
    return undefined;
  }

  /** A negative archive result is shared only within this synchronous retention sweep. */
  withinSweep(work: () => number): number {
    const previous = this.sweep;
    this.sweep = { archiveFailed: false };
    try { return work(); } finally { this.sweep = previous; }
  }

  /** Synchronous: no ingest or check callback can interleave verification and deletion. */
  beforeDelete(traceId: string): void {
    const run = this.roots.store.getRun(traceId);
    if (!run || !this.covered(run)) return;
    const reason = this.reason(run);
    if (reason) throw new Error(`audit hold: ${reason}`);
    if (this.sweep?.archiveFailed) {
      this.failed(traceId);
      throw new Error(`audit hold: ${this.failures.get(traceId)}`);
    }
    try {
      this.archive.ensure(traceId, this.directory());
      this.failures.delete(traceId);
    } catch (e) {
      if (this.sweep && e instanceof ArchiveUnavailableError) this.sweep.archiveFailed = true;
      // Paths/hashes are useful; never echo a parser's potentially private payload text.
      this.failures.set(traceId, "archive could not be written or verified; inspect the local archive directory and permissions");
      log.warn(`audit archive failed for ${traceId}: local write or verification failed`);
      throw new Error(`audit hold: ${this.failures.get(traceId)}`, { cause: e });
    }
  }

  private candidate(run: RunRow): boolean {
    return !run.doctor && !!run.project && projectSettings(this.roots.config, run.project).audit;
  }

  private failed(traceId: string): void {
    this.failures.set(traceId, "archive could not be written or verified; inspect the local archive directory and permissions");
    log.warn(`audit archive failed for ${traceId}: local write or verification failed`);
  }

  private arm(): void {
    if (this.timer || (!this.pending.size && !this.periodic.size)) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 1500);
    this.timer.unref();
  }

  private schedule(traceId: string): void {
    const run = this.roots.store.getRun(traceId);
    // Exact unknown-project evidence may hydrate payloads; defer it to the bounded drain.
    if (!run || !this.candidate(run)) return;
    this.pending.add(traceId);
    this.arm();
  }

  private drain(): void {
    const selected = new Set<string>();
    const take = (queue: Set<string>, limit: number) => {
      for (const id of queue) {
        if (selected.size >= limit) break;
        queue.delete(id);
        selected.add(id);
      }
    };
    // Reserve half a batch for periodic capture even under continuous event traffic.
    take(this.periodic, 16);
    take(this.pending, 32);
    take(this.periodic, 32);
    const ready: string[] = [];
    for (const id of selected) {
      this.pending.delete(id);
      this.periodic.delete(id);
      const run = this.roots.store.getRun(id);
      if (!run || !this.candidate(run) || this.reason(run)) continue;
      try { if (this.covered(run)) ready.push(id); }
      catch { this.failed(id); }
    }
    try {
      const result = this.archive.ensureMany(ready, this.directory());
      for (const id of result.archived) this.failures.delete(id);
      for (const id of result.failed) this.failed(id);
    } catch {
      for (const id of ready) this.failed(id);
    }
    this.arm();
  }

  private scheduleAll(): void {
    if (!this.roots.config.audit.enabled && !Object.values(this.roots.config.projects).some(p => p.audit === true)) return;
    const runs = this.roots.store.db.prepare("SELECT * FROM runs WHERE trace_id > ? ORDER BY trace_id LIMIT 32").all(this.cursor) as RunRow[];
    this.cursor = runs.length === 32 ? runs[31].trace_id : "";
    for (const run of runs) if (this.candidate(run)) this.periodic.add(run.trace_id);
    this.arm();
  }

  forgotten(ids: string[]): void {
    for (const id of ids) {
      this.pending.delete(id);
      this.periodic.delete(id);
      this.failures.delete(id);
    }
  }

  /** Read-only status; snapshot byte counts exclude SQLite/index/shared-blob overhead. */
  status() {
    const directory = this.directory();
    const exists = fs.existsSync(directory);
    const verification = exists ? verifyArchive(directory) : undefined;
    const entries = verification?.ok ? verification.entries : [];
    let archiveBytes = 0;
    if (verification?.ok) {
      archiveBytes = readFile(path.join(directory, "manifest.jsonl")).length;
      for (const entry of entries) {
        const dir = path.join(directory, path.dirname(entry.path));
        archiveBytes += readFile(path.join(dir, "trace.json")).length + readFile(path.join(dir, "record.json")).length;
      }
    }
    let covered = 0, held = 0, archived = 0, heldBytes = 0, archivedBytes = 0;
    const reasons = new Map<string, number>();
    const runs = this.roots.store.db.prepare("SELECT * FROM runs").all() as RunRow[];
    for (const run of runs) {
      if (!this.covered(run)) continue;
      covered++;
      let bytes = 0, current = false;
      let reason = this.reason(run) ?? this.failures.get(run.trace_id);
      try {
        const data = snapshot(this.roots, run.trace_id);
        bytes = data.trace.length + data.record.length;
        const last = entries.findLast((e) => e.trace_id === run.trace_id);
        current = !reason && last?.bundle_sha256 === sha256(data.trace) && last.sidecar_sha256 === sha256(data.record);
      } catch { reason = "stored payload unavailable"; }
      if (current) { archived++; archivedBytes += bytes; }
      else {
        held++; heldBytes += bytes;
        reason ??= this.failures.get(run.trace_id) ?? (verification && !verification.ok ? "archive verification failed" : "current snapshot not archived");
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    return { enabled: this.roots.config.audit.enabled, directory, covered_runs: covered,
      held_runs: held, held_bytes: heldBytes, archived_live_runs: archived, archived_live_bytes: archivedBytes,
      archived_runs: new Set(entries.map((e) => e.trace_id)).size, archive_entries: entries.length, archive_bytes: archiveBytes,
      live_store_bytes: this.roots.store.storedBytes(), seq: verification?.seq ?? 0, head: verification?.head ?? null,
      verified: verification?.ok ?? null, hold_reasons: Object.fromEntries(reasons),
      failures: [...this.failures].filter(([id]) => { const run = this.roots.store.getRun(id); return run && this.covered(run); }).map(([trace_id, error]) => ({ trace_id, error })),
      verification_errors: verification && !verification.ok ? ["archive verification failed; run audit verify for artifact details"] : [] };
  }

  close(): void {
    clearInterval(this.interval);
    clearTimeout(this.timer);
    this.pending.clear();
    this.periodic.clear();
    for (const off of this.unsubscribe) off();
  }
}
