import path from "node:path";
import type { Roots } from "../core.js";
import type { RunRow } from "../types.js";
import { buildView } from "../semantics/view.js";
import { kvToPlain } from "../otlp/types.js";
import { projectSettings } from "../config.js";
import { ArchiveUnavailableError, AuditArchive } from "./archive.js";
import { archiveObservations } from "./observations.js";
import { namedUnknownProjects } from "./project-evidence.js";
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
      archiveObservations(this.roots.store).clearError(traceId);
    } catch (e) {
      if (this.sweep && e instanceof ArchiveUnavailableError) this.sweep.archiveFailed = true;
      // Paths/hashes are useful; never echo a parser's potentially private payload text.
      this.failed(traceId);
      throw new Error(`audit hold: ${this.failures.get(traceId)}`, { cause: e });
    }
  }

  private candidate(run: RunRow): boolean {
    return !run.doctor && !!run.project && projectSettings(this.roots.config, run.project).audit;
  }

  private failed(traceId: string): void {
    archiveObservations(this.roots.store).error(traceId);
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
      for (const id of result.archived) {
        this.failures.delete(id);
        archiveObservations(this.roots.store).clearError(id);
      }
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

  /** Metadata aggregates and last observations only; never verify or hydrate on a read. */
  status() {
    const projects = (this.roots.store.db.prepare("SELECT DISTINCT project FROM runs WHERE doctor=0").all() as { project: string }[])
      .map(r => r.project).filter(p => p && projectSettings(this.roots.config, p).audit);
    const pending = this.roots.engine ? (this.roots.store.db.prepare("SELECT trace_id FROM runs WHERE doctor=0").all() as { trace_id: string }[])
      .filter(r => !this.roots.engine!.auditReady(r.trace_id)).map(r => r.trace_id) : [];
    return { enabled: this.roots.config.audit.enabled, directory: this.directory(),
      ...archiveObservations(this.roots.store).status(this.directory(), projects, namedUnknownProjects(this.roots.store), !!this.roots.engine, pending) };
  }

  close(): void {
    clearInterval(this.interval);
    clearTimeout(this.timer);
    this.pending.clear();
    this.periodic.clear();
    for (const off of this.unsubscribe) off();
  }
}
