import { Worker } from "node:worker_threads";
import type { Store } from "./store/db.js";
import { reclaimPendingBlobs, type RetentionCandidate } from "./store/retention-state.js";
import { log } from "./util/log.js";

type Cursor = { received_ms: number; id: number };
const ORPHAN = "(trace_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = logs.trace_id))";
const yieldOwner = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One scheduled sweep, including pending payload cleanup. Workers have no deletion authority. */
export class Retention {
  private active?: Promise<number>;
  private worker?: Worker;
  private closing = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly store: Store) {}

  run(days: number, maxBytes: number): Promise<number> {
    if (this.closing) return Promise.reject(new Error("retention is closed"));
    if (this.active) return this.active;
    this.active = this.sweep(days, maxBytes).finally(() => { this.active = undefined; });
    return this.active;
  }

  private request<T>(type: string, args: unknown = {}): Promise<T> {
    if (this.closing || !this.worker) return Promise.reject(new Error("retention stopped"));
    const worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`retention ${type} timed out`));
        void worker.terminate();
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, type, args });
    });
  }

  private open(): void {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./retention-worker.ts" : "./retention-worker.js", import.meta.url), {
      workerData: { dir: this.store.dir }, ...(source ? { execArgv: ["--import", "tsx"] } : {}),
    });
    this.worker = worker;
    worker.on("message", (message: { id?: number; value?: unknown; error?: string; progress?: boolean }) => {
      if (message.progress || message.id === undefined) return;
      const call = this.pending.get(message.id); if (!call) return;
      clearTimeout(call.timer); this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.value);
    });
    const fail = (error: Error) => {
      for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
      this.pending.clear();
    };
    worker.once("error", fail);
    worker.once("exit", (code) => { fail(new Error(`retention worker exited (${code})`)); });
  }

  private async cleanup(): Promise<void> {
    while (!this.closing && reclaimPendingBlobs(this.store.db, this.store.dir)) await yieldOwner();
  }

  private async sweep(days: number, maxBytes: number): Promise<number> {
    let removed = 0;
    const protectedIds = new Set<string>();
    const deadline = Date.now() + 120_000;
    const apply = async (candidates: RetentionCandidate[]) => {
      let skipped = false;
      for (const candidate of candidates) {
        if (this.closing) throw new Error("retention stopped");
        const result = this.store.deleteRetentionCandidate(candidate);
        if (result === "removed") removed++;
        else { protectedIds.add(candidate.trace_id); skipped = true; }
        await yieldOwner();
        if (skipped) break; // Replan shared/protected weights before trusting another candidate.
      }
      await this.cleanup();
      await this.request("collectIndex");
    };
    const logs = async (options: { cutoff?: number; maxBytes?: number }) => {
      let cursor: Cursor | undefined;
      while (!this.closing && Date.now() < deadline) {
        const batch = await this.request<{ ids: number[]; cursor?: Cursor }>("logs", { ...options, cursor });
        if (!batch.ids.length) break;
        if (this.closing) throw new Error("retention stopped");
        this.store.db.prepare(`DELETE FROM logs WHERE id IN (SELECT value FROM json_each(?)) AND ${ORPHAN}
          ${options.cutoff === undefined ? "" : "AND received_ms < ?"}`)
          .run(JSON.stringify(batch.ids), ...(options.cutoff === undefined ? [] : [options.cutoff]));
        cursor = batch.cursor;
        await yieldOwner();
      }
    };
    try {
      this.open();
      await this.request("initialize");
      this.store.refreshRetentionSearch();
      await this.request("collectIndex");
      await this.cleanup();
      if (Number.isFinite(days) && days >= 1) {
        const cutoff = Date.now() - days * 86_400_000;
        while (!this.closing && Date.now() < deadline) {
          const candidates = await this.request<RetentionCandidate[]>("age", { cutoff, protectedIds: [...protectedIds] });
          if (!candidates.length) break;
          await apply(candidates);
        }
        await logs({ cutoff });
      }
      const start = await this.request<{ over: boolean; compacted: boolean }>("sizeStart", { maxBytes });
      if (start.over) await logs({ maxBytes });
      // As in Store.sweep, orphan logs get first refusal: only activate run hysteresis if the
      // fresh post-log total still exceeds the cap, even if it remains above the low-water target.
      const runsOver = start.over && await this.request<number>("sizeCheck") > maxBytes;
      if (!start.compacted) log.warn("retention index maintenance reached its time budget; run eviction deferred");
      if (runsOver && start.compacted) {
        const targetBytes = maxBytes * 0.9;
        while (!this.closing && Date.now() < deadline) {
          const plan = await this.request<{ size: number; candidates: RetentionCandidate[] }>("size", { maxBytes, targetBytes, protectedIds: [...protectedIds] });
          if (!plan.candidates.length) {
            if (plan.size > maxBytes) log.warn(`retention remains above size cap: ${plan.size} bytes stored, ${maxBytes} byte cap; protected or non-run data retained`);
            else if (plan.size > targetBytes) log.warn(`retention low-water target unattainable: ${plan.size} bytes stored, ${targetBytes} byte target; protected or non-run data retained`);
            break;
          }
          await apply(plan.candidates);
        }
      }
      if (Date.now() >= deadline) log.warn("retention reached its time budget; remaining data retained for the next sweep");
      await this.cleanup();
      await this.request("finish");
      return removed;
    } finally {
      const worker = this.worker; this.worker = undefined;
      if (worker) await worker.terminate();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.worker?.terminate();
    await this.active?.catch(() => undefined);
  }
}
