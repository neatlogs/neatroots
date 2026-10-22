import crypto from "node:crypto";
import type { Roots } from "../../core.js";
import { getCloudToken } from "../../relay/keychain.js";
import { log } from "../../util/log.js";
import { cloudApiBase, neatlogsCloudSource, type CloudAuth } from "./neatlogs-cloud.js";
import { ImportError, type ImportSource } from "./types.js";
import { endpointProblem } from "../../relay/endpoint.js";
import { attr } from "../../otlp/types.js";
import { hexId } from "../build.js";

export { parseTraceFile } from "./file.js";

/** The stored service-account token and the chosen project, or undefined when no token is stored. */
export async function cloudImportAuth(roots: Roots): Promise<CloudAuth | undefined> {
  const token = await getCloudToken();
  return token ? { token, projectId: roots.config.cloud.projectId || undefined } : undefined;
}

export function cloudImportBase(roots: Roots): string {
  const base = cloudApiBase(roots.relay.endpoint(), roots.config.cloud.apiBase);
  // The service-account token goes to this base: same rule as forwarding a key.
  const problem = endpointProblem(base, !!roots.config.cloud.trustEndpoint);
  if (problem) throw new ImportError(problem);
  return base;
}
export { ImportError } from "./types.js";
export type { ImportSource, ImportField } from "./types.js";

export interface ImportJob {
  id: string;
  source: string;
  label: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  started_ms: number;
  finished_ms: number | null;
  traces: number;
  spans: number;
  failed: number;
  /** Traces that are runs captured here (a run sent to Cloud from here, say): kept, not imported over. */
  skipped: number;
  last_error: string | null;
  /** Local trace ids of the first runs imported (or kept), for links. */
  trace_ids: string[];
  project: string | null;
  window: { since_ms: number; until_ms: number };
}

/** Imports from Neatlogs Cloud, run in the background one trace at a time. */
export class ImportJobs {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly controllers = new Map<string, AbortController>();
  readonly sources: ImportSource[];

  constructor(private readonly roots: Roots) {
    this.sources = [
      neatlogsCloudSource(
        () => cloudImportBase(roots),
        () => cloudImportAuth(roots),
      ),
    ];
  }

  source(id: string): ImportSource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  list(): ImportJob[] {
    return [...this.jobs.values()].sort((a, b) => b.started_ms - a.started_ms);
  }

  get(id: string): ImportJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * A run with spans captured here (an SDK, OTLP, the HTTP API, a file), as opposed to one imported
   * from Neatlogs Cloud before. A run sent to Cloud keeps its ids there, and Cloud's copy (redacted,
   * with only the public API's fields) must not replace it; a Cloud import can be refreshed.
   */
  private capturedHere(traceId: string): boolean {
    if (!this.roots.store.getRun(traceId)) return false;
    return this.roots.store.resourcesFor(traceId).some((r) => attr(r.attributes, "neatroots.import.source") !== "neatlogs-cloud");
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Starts an import; resolves when it finishes. The job is visible in list() as it runs. */
  start(
    sourceId: string,
    values: Record<string, string>,
    opts: { sinceMs?: number; untilMs?: number; limit?: number; project?: string } = {},
  ): { job: ImportJob; done: Promise<ImportJob> } {
    const source = this.source(sourceId);
    if (!source) throw new ImportError(`unknown import source "${sourceId}"`);
    const missing = source.fields.filter((f) => f.required && !values[f.name]?.trim()).map((f) => f.label);
    if (missing.length) throw new ImportError(`${source.label} needs: ${missing.join(", ")}`);
    const filled = { ...Object.fromEntries(source.fields.filter((f) => f.default).map((f) => [f.name, f.default!])), ...values };
    const untilMs = opts.untilMs ?? Date.now();
    const job: ImportJob = {
      id: crypto.randomUUID(),
      source: source.id,
      label: source.label,
      state: "running",
      started_ms: Date.now(),
      finished_ms: null,
      traces: 0,
      spans: 0,
      failed: 0,
      skipped: 0,
      last_error: null,
      trace_ids: [],
      project: opts.project ?? null,
      window: { since_ms: opts.sinceMs ?? untilMs - 7 * 86_400_000, until_ms: untilMs },
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 50) this.jobs.delete(this.list().at(-1)!.id);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const done = (async () => {
      try {
        const kept = (sourceId: string) => (this.capturedHere(hexId(sourceId, 16)) ? hexId(sourceId, 16) : undefined);
        for await (const t of source.traces({ values: filled, sinceMs: job.window.since_ms, untilMs, limit: opts.limit ?? 100, project: opts.project, signal: controller.signal, kept })) {
          if (t.error) {
            job.failed += 1;
            job.last_error = `trace ${t.sourceId}: ${t.error}`;
            this.roots.bus.emit("import", { ...job });
            continue;
          }
          // Checked again right before storing: the run may have started arriving while it downloaded.
          const here = t.kept ?? [...new Set(t.batches.flatMap((b) => b.spans.map((s) => s.traceId)))].find((id) => this.capturedHere(id));
          if (here) {
            job.skipped += 1;
            if (job.trace_ids.length < 20 && !job.trace_ids.includes(here)) job.trace_ids.push(here);
            this.roots.bus.emit("import", { ...job });
            continue;
          }
          try {
            const updates = this.roots.ingest(t.batches);
            job.traces += 1;
            job.spans += t.batches.reduce((n, b) => n + b.spans.length, 0);
            for (const u of updates) if (job.trace_ids.length < 20 && !job.trace_ids.includes(u.traceId)) job.trace_ids.push(u.traceId);
          } catch (err) {
            job.failed += 1;
            job.last_error = `trace ${t.sourceId}: ${(err as Error).message}`;
          }
          this.roots.bus.emit("import", { ...job });
        }
        job.state = controller.signal.aborted ? "cancelled" : "succeeded";
      } catch (err) {
        job.state = controller.signal.aborted ? "cancelled" : "failed";
        if (!controller.signal.aborted) job.last_error = (err as Error).message;
        if (job.state === "failed") log.warn(`${source.label} import failed: ${job.last_error}`);
      } finally {
        job.finished_ms = Date.now();
        this.controllers.delete(job.id);
        this.roots.bus.emit("import", { ...job });
      }
      return job;
    })();
    return { job, done };
  }
}
