import type { Bus } from "../bus.js";
import type { Finding, Note } from "../types.js";
import { parseWebhooks, type WebhookConfig } from "./config.js";
import { postWebhook, safeId, type WebhookEvent } from "./payload.js";
interface Job { destination: WebhookConfig; event: WebhookEvent; entity: string; abort: AbortController }
export interface DispatcherOptions { capacity: number; concurrency: number; attempts: number; timeoutMs: number; retryMs: number; dedupeSize: number }
const defaults: DispatcherOptions = { capacity: 128, concurrency: 2, attempts: 3, timeoutMs: 5000, retryMs: 250, dedupeSize: 4096 };
/** Best-effort bounded notifications. No network promise is awaited by a bus listener. */
export class WebhookDispatcher {
  private destinations: WebhookConfig[] = [];
  private queue: Job[] = [];
  private active = new Set<Job>();
  private seen = new Map<string, true>();
  private handlers: (() => void)[] = [];
  private settingsOff: () => void;
  private closed = false;
  private scheduled = false;
  readonly stats = { accepted: 0, sent: 0, failed: 0, dropped: 0, retried: 0, cancelled: 0 };
  private readonly limits: DispatcherOptions;
  constructor(private bus: Bus, private getConfig: () => unknown, options: Partial<DispatcherOptions> = {}) {
    this.limits = { ...defaults, ...options };
    const maxima: DispatcherOptions = { capacity: 1024, concurrency: 16, attempts: 3, timeoutMs: 5000, retryMs: 1000, dedupeSize: 8192 };
    for (const key of Object.keys(this.limits) as (keyof DispatcherOptions)[]) {
      if (!Number.isInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > maxima[key]) throw new Error("Invalid webhook dispatcher limit");
    }
    this.settingsOff = bus.on("settings", () => this.reconcile());
    this.reconcile();
  }
  get pending(): number { return this.queue.length; }
  get inFlight(): number { return this.active.size; }
  reconcile(): void {
    if (this.closed) return;
    let next: WebhookConfig[];
    try { next = parseWebhooks(this.getConfig()); } catch { next = []; }
    if (JSON.stringify(next) === JSON.stringify(this.destinations)) return;
    this.cancel(); this.destinations = next;
    if (!next.length) return;
    this.handlers = [this.bus.on("finding", (f) => this.finding(f)), this.bus.on("note", (n) => this.note(n))];
  }
  private cancel(): void {
    for (const off of this.handlers) off();
    this.handlers = [];
    this.stats.cancelled += this.queue.length;
    this.queue = [];
    for (const job of this.active) if (!job.abort.signal.aborted) { this.stats.cancelled++; job.abort.abort(); }
    this.seen.clear();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.settingsOff(); this.cancel(); this.destinations = [];
  }
  private finding(f: Finding): void {
    if (f.status !== "raised" && f.status !== "active") return;
    const id = safeId(f.id); const trace = safeId(f.trace_id);
    if (!id || !trace) return;
    this.enqueue("finding:" + id, { event: "finding", state: f.status, finding_id: id, trace_id: trace, check_id: safeId(f.check_id) });
  }
  private note(n: Note): void {
    if (n.kind !== "halt") return;
    const id = safeId(n.id); const trace = safeId(n.trace_id);
    if (!id || !trace) return;
    const entity = "halt:" + id;
    if (n.status !== "pending" && n.status !== "delivered") {
      const removed = this.queue.filter((j) => j.entity === entity);
      this.queue = this.queue.filter((j) => j.entity !== entity);
      this.stats.cancelled += removed.length;
      for (const job of this.active) if (job.entity === entity && !job.abort.signal.aborted) { this.stats.cancelled++; job.abort.abort(); }
      return;
    }
    this.enqueue(entity, { event: "halt", state: n.status === "pending" ? "queued" : "delivered", note_id: id, trace_id: trace, finding_id: safeId(n.finding_id) });
  }
  private enqueue(entity: string, event: WebhookEvent): void {
    for (const destination of this.destinations) {
      if (!destination.events.includes(event.event as "halt" | "finding")) continue;
      const key = JSON.stringify([destination.url, destination.format, entity, event.event === "halt" ? event.state : "finding"]);
      if (this.seen.has(key)) continue;
      if (this.queue.length >= this.limits.capacity) { this.stats.dropped++; continue; }
      if (this.seen.size >= this.limits.dedupeSize) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(key, true);
      this.queue.push({ destination, event, entity, abort: new AbortController() }); this.stats.accepted++;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.pump(); });
    }
  }
  private pump(): void {
    if (this.closed) return;
    while (this.active.size < this.limits.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.active.add(job);
      void this.run(job).catch(() => { if (!job.abort.signal.aborted) this.stats.failed++; }).finally(() => { this.active.delete(job); this.pump(); });
    }
  }
  private async run(job: Job): Promise<void> {
    for (let attempt = 0; attempt < this.limits.attempts && !job.abort.signal.aborted; attempt++) {
      const result = await postWebhook(job.destination, job.event, job.abort.signal, this.limits.timeoutMs);
      if (job.abort.signal.aborted) return;
      if (result === "sent") { this.stats.sent++; return; }
      if (result === "rejected" || attempt + 1 === this.limits.attempts) { this.stats.failed++; return; }
      this.stats.retried++;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); job.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.limits.retryMs * 2 ** attempt);
        job.abort.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
