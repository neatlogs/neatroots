import fs from "node:fs";
import path from "node:path";
import type { Roots } from "../core.js";
import type { RunRow } from "../types.js";
import { buildView } from "../semantics/view.js";
import { kvToPlain } from "../otlp/types.js";
import { projectSettings } from "../config.js";
import { AuditArchive, snapshot } from "./archive.js";
import { readFile, sha256 } from "./files.js";
import { verifyArchive } from "./manifest.js";
import { log } from "../util/log.js";

/** Server-owned archive-before-release policy. No background task mutates archive bytes. */
export class AuditHold {
  private readonly archive: AuditArchive;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failures = new Map<string, string>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly interval: NodeJS.Timeout;

  constructor(private readonly roots: Roots) {
    this.archive = new AuditArchive(roots);
    this.unsubscribe.push(roots.bus.on("trace", (u) => this.schedule(u.traceId)));
    for (const event of ["finding", "explanation", "summary"] as const) {
      this.unsubscribe.push(roots.bus.on(event, (u) => this.schedule(u.trace_id)));
    }
    this.unsubscribe.push(roots.bus.on("settings", () => this.scheduleAll()));
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

  /** Synchronous: no ingest or check callback can interleave verification and deletion. */
  beforeDelete(traceId: string): void {
    const run = this.roots.store.getRun(traceId);
    if (!run || !this.covered(run)) return;
    const reason = this.reason(run);
    if (reason) throw new Error(`audit hold: ${reason}`);
    try {
      this.archive.ensure(traceId, this.directory());
      this.failures.delete(traceId);
    } catch (e) {
      // Paths/hashes are useful; never echo a parser's potentially private payload text.
      this.failures.set(traceId, "archive could not be written or verified; inspect the local archive directory and permissions");
      log.warn(`audit archive failed for ${traceId}: local write or verification failed`);
      throw new Error(`audit hold: ${this.failures.get(traceId)}`, { cause: e });
    }
  }

  private schedule(traceId: string): void {
    const run = this.roots.store.getRun(traceId);
    if (!run || !this.covered(run)) return;
    if (this.timers.has(traceId)) clearTimeout(this.timers.get(traceId));
    const timer = setTimeout(() => {
      this.timers.delete(traceId);
      const run = this.roots.store.getRun(traceId);
      if (!run || !this.covered(run) || this.reason(run)) return;
      try { this.beforeDelete(traceId); } catch { /* Visible in status; retry on change/periodic scan. */ }
    }, 1500);
    timer.unref();
    this.timers.set(traceId, timer);
  }

  private scheduleAll(): void {
    if (!this.roots.config.audit.enabled && !Object.values(this.roots.config.projects).some(p => p.audit === true)) return;
    const runs = this.roots.store.db.prepare("SELECT * FROM runs").all() as RunRow[];
    for (const run of runs) if (this.covered(run)) this.schedule(run.trace_id);
  }

  forgotten(ids: string[]): void {
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const off of this.unsubscribe) off();
  }
}
