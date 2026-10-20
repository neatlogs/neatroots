import crypto from "node:crypto";
import type { Roots } from "../core.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import { BatchEvidence } from "./batch-evidence.js";
import type { Replay, ReplayOverrides } from "./replay.js";

export function repeatCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20)
    throw new Error("times must be an integer from 1 to 20");
  return value;
}

export interface ReplayBatch {
  id: string;
  trace_id: string;
  times: number;
  state: "running" | "cancelling" | "completed" | "cancelled" | "interrupted" | "failed";
  created_ms: number;
  finished_ms: number | null;
  error: string | null;
}
export interface BatchRepeat {
  ordinal: number;
  replay_id: string | null;
  state: "queued" | "running" | "pending" | "settled" | "failed" | "unlinked" | "cancelled";
  trace_id: string | null;
  execution_failed?: boolean;
  agent_status?: string;
}
export interface BatchSummary extends ReplayBatch {
  repeats: BatchRepeat[];
  linked: number;
  settled: number;
  clean: number;
  pending: number;
  failed: number;
  execution_failed: number;
  evaluation_failed: number;
  unlinked: number;
  cancelled: number;
  findings: { check_id: string; count: number; original: boolean }[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Batch metadata never changes the ordinary replay's correlation or stored spans. */
export class ReplayBatches {
  private readonly evidence: BatchEvidence;
  private closed = false;
  private readonly stopped: Promise<null>;
  private stop!: () => void;
  private readonly snapshots = new Map<string, BatchSummary>();
  private readonly active = new Set<string>();
  constructor(private readonly roots: Roots) {
    this.stopped = new Promise((resolve) => { this.stop = () => resolve(null); });
    roots.store.db.exec(`CREATE TABLE IF NOT EXISTS replay_batches (
      id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, times INTEGER NOT NULL, state TEXT NOT NULL,
      created_ms INTEGER NOT NULL, finished_ms INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS replay_batch_members (
      batch_id TEXT NOT NULL, ordinal INTEGER NOT NULL, replay_id TEXT, PRIMARY KEY(batch_id,ordinal));
      CREATE TABLE IF NOT EXISTS replay_evidence (
      replay_id TEXT NOT NULL, trace_id TEXT NOT NULL, PRIMARY KEY(replay_id,trace_id));
      CREATE TABLE IF NOT EXISTS replay_batch_exits (replay_id TEXT PRIMARY KEY, code INTEGER);
      CREATE TABLE IF NOT EXISTS replay_observations (trace_id TEXT NOT NULL, check_id TEXT NOT NULL, PRIMARY KEY(trace_id,check_id));
      CREATE TABLE IF NOT EXISTS replay_evaluation_failures (finding_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replay_batch_original (batch_id TEXT NOT NULL, check_id TEXT NOT NULL, PRIMARY KEY(batch_id,check_id));
      `);
    this.evidence = new BatchEvidence(roots.store);
    for (const row of roots.store.db.prepare("SELECT DISTINCT replay_id FROM replay_batch_members WHERE replay_id IS NOT NULL").all() as { replay_id: string }[]) this.associate(row.replay_id);
    roots.store.db.prepare(`UPDATE replay_batches SET state='interrupted', finished_ms=?,
      error='interrupted by a restart' WHERE state IN ('running','cancelling')`).run(Date.now());
    roots.bus.on("finding", (finding) => {
      if (this.closed || !roots.store.db.open || !roots.store.getRun(finding.trace_id) || !this.evidence.relevant(finding.trace_id)) return;
      if (finding.status === "failed" || (finding.check_kind === "question" && finding.probability === null && finding.detail?.error)) {
        roots.store.db.prepare("INSERT OR IGNORE INTO replay_evaluation_failures VALUES (?,?)").run(finding.id, finding.trace_id);
        return;
      }
      if (roots.store.db.prepare("SELECT 1 FROM replay_evaluation_failures WHERE finding_id=?").get(finding.id)) return;
      if (roots.store.db.prepare(`SELECT 1 FROM replay_evidence WHERE trace_id=? UNION ALL
        SELECT 1 FROM replay_batches WHERE trace_id=? LIMIT 1`).get(finding.trace_id, finding.trace_id))
        roots.store.db.prepare("INSERT OR IGNORE INTO replay_observations VALUES (?,?)").run(finding.trace_id, finding.check_id);
    });
  }

  observe(batches: ResourceSpansBatch[]): void {
    if (!this.closed && this.roots.store.db.open) {
      for (const id of this.evidence.observe(batches)) this.associate(id);
    }
  }

  private associate(id: string): void {
    const trace = this.evidence.uniqueTrace(id);
    // Keep legacy fallback navigation when no explicit claim arrived. Once claims
    // exist, ambiguity must invalidate navigation as well as the batch summary.
    if (trace || this.evidence.hasEvidence(id)) this.roots.replays.associateBatch(id, trace);
  }

  start(traceId: string, times: unknown, overrides: ReplayOverrides = {}): { batch: BatchSummary; done: Promise<BatchSummary> } {
    if (this.closed) throw new Error("replay batches are shutting down");
    const n = repeatCount(times);
    const run = this.roots.store.getRun(traceId);
    if (!run) throw new Error("run not found");
    const target = this.roots.replays.target(run.project);
    if (!target?.command && !target?.url) throw new Error("no way to re-run this agent; register a rerun command or endpoint first");
    const id = `rb_${crypto.randomBytes(8).toString("hex")}`;
    const db = this.roots.store.db;
    db.transaction(() => {
      db.prepare("INSERT INTO replay_batches VALUES (?,?,?,'running',?,NULL,NULL)").run(id, traceId, n, Date.now());
      for (let i = 1; i <= n; i++) db.prepare("INSERT INTO replay_batch_members (batch_id,ordinal,replay_id) VALUES (?,?,NULL)").run(id, i);
      for (const check of this.checks(traceId)) db.prepare("INSERT INTO replay_batch_original VALUES (?,?)").run(id, check);
    })();
    const batch = this.get(id)!;
    this.active.add(id);
    const done = this.execute(id, overrides).catch((e: Error) => {
      if (!this.closed && db.open) this.finish(id, "failed", e.message);
      return this.get(id) ?? this.removed(batch);
    }).finally(() => { this.active.delete(id); this.snapshots.delete(id); });
    return { batch, done };
  }

  private finish(id: string, state: ReplayBatch["state"], error: string | null = null): void {
    if (this.closed || !this.roots.store.db.open) return;
    this.roots.store.db.prepare("UPDATE replay_batches SET state=?,finished_ms=?,error=? WHERE id=?").run(state, Date.now(), error, id);
  }

  cancel(id: string): BatchSummary | undefined {
    if (this.closed || !this.roots.store.db.open) return this.get(id);
    this.roots.store.db.prepare("UPDATE replay_batches SET state='cancelling' WHERE id=? AND state='running'").run(id);
    return this.get(id);
  }

  private async execute(id: string, overrides: ReplayOverrides): Promise<BatchSummary> {
    const b = this.get(id)!;
    for (let ordinal = 1; ordinal <= b.times; ordinal++) {
      if (this.closed || this.get(id)?.state !== "running") break;
      const { replay, done } = this.roots.replays.startRun(b.trace_id, overrides, (code) => {
        if (!this.closed && this.roots.store.db.open) this.roots.store.db.prepare("INSERT OR REPLACE INTO replay_batch_exits SELECT ?,? WHERE EXISTS (SELECT 1 FROM replay_batch_members WHERE replay_id=? AND deleted=0)").run(replay.id, code, replay.id);
      }, (created) => {
        if (this.closed || !this.roots.store.db.open) return;
        this.roots.store.db.prepare("UPDATE replay_batch_members SET replay_id=? WHERE batch_id=? AND ordinal=?").run(created.id, id, ordinal);
      });
      // Existing replay timeout plus the telemetry flush window. Stop dispatch if it fails to settle;
      // this watchdog does not assert that the child process has terminated.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = done.then((result) => {
        // Completion can arrive after the watchdog returned. Reconcile its saved
        // navigation then too; a late finish must not revive contested evidence.
        if (!this.closed && this.roots.store.db.open) this.associate(replay.id);
        return result;
      });
      const result = await Promise.race([completed, this.stopped, new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 15 * 60_000 + 11_000);
      })]);
      clearTimeout(timer);
      if (this.closed || !this.get(id) || this.get(id)!.state === "cancelled") return this.get(id) ?? this.removed(b);
      this.associate(replay.id);
      if (!result) {
        this.finish(id, "failed", "active replay exceeded its deadline; process termination is unconfirmed, remaining repeats stopped");
        return this.get(id)!;
      }
      // Bound the wait for checks; summaries keep updating from durable receipts afterward.
      const until = Date.now() + 5_000;
      while (!this.closed && this.get(id)?.state === "running" && this.repeat(replay.id, ordinal).state === "pending" && Date.now() < until) await sleep(100);
    }
    if (this.closed || !this.get(id) || this.get(id)!.state === "cancelled") return this.get(id) ?? this.removed(b);
    this.finish(id, this.get(id)!.state === "cancelling" ? "cancelled" : "completed");
    return this.get(id)!;
  }

  private removed(b: BatchSummary): BatchSummary {
    return { ...b, trace_id: "", state: "cancelled", error: "original run or batch deleted", finished_ms: Date.now(),
      repeats: [], findings: [], linked: 0, settled: 0, clean: 0, pending: 0, failed: 0,
      execution_failed: 0, evaluation_failed: 0, unlinked: 0, cancelled: 0 };
  }

  delete(id: string): void {
    if (!this.closed && this.roots.store.db.open) this.roots.store.db.prepare("DELETE FROM replay_batches WHERE id=?").run(id);
  }

  private repeat(replayId: string, ordinal: number): BatchRepeat {
    const r: Replay | undefined = this.roots.replays.get(replayId);
    const base = { ordinal, replay_id: replayId, trace_id: null };
    if (this.roots.store.db.prepare("SELECT 1 FROM replay_batch_members WHERE replay_id=? AND deleted=1").get(replayId)) return { ...base, state: "unlinked" };
    if (!r) return { ...base, state: "failed", execution_failed: true };
    if (r.state === "running") return { ...base, state: "running" };
    const exit = this.roots.store.db.prepare("SELECT code FROM replay_batch_exits WHERE replay_id=?").get(replayId) as { code: number | null } | undefined;
    const trace = this.evidence.uniqueTrace(replayId);
    const executionFailed = r.state === "failed" || !!(exit && exit.code !== 0);
    if (!trace) return { ...base, state: executionFailed ? "failed" : "unlinked", execution_failed: executionFailed };
    const run = this.roots.store.getRun(trace);
    const state = this.roots.checkCompletion.state(trace);
    const linked = { ...base, trace_id: trace, execution_failed: executionFailed || run?.status === "error" || run?.interrupted === 1, agent_status: run?.status };
    if (state === "failed") return { ...linked, state: "failed" };
    return { ...linked, state: state === "settled" && (run?.root_ended || run?.complete || run?.interrupted) && !this.roots.engine?.pending(trace) ? "settled" : "pending" };
  }

  get(id: string): BatchSummary | undefined {
    if (this.closed || !this.roots.store.db.open) return this.snapshots.get(id);
    const b = this.roots.store.db.prepare("SELECT * FROM replay_batches WHERE id=?").get(id) as ReplayBatch | undefined;
    if (!b) return;
    const members = this.roots.store.db.prepare("SELECT ordinal,replay_id FROM replay_batch_members WHERE batch_id=? ORDER BY ordinal").all(id) as { ordinal: number; replay_id: string | null }[];
    const repeats: BatchRepeat[] = members.map((m) => m.replay_id ? this.repeat(m.replay_id, m.ordinal) : {
      ...m, trace_id: null, state: b.state === "running" ? "queued" : b.state === "interrupted" ? "pending" : "cancelled",
    });
    const original = new Set((this.roots.store.db.prepare("SELECT check_id FROM replay_batch_original WHERE batch_id=?").all(id) as { check_id: string }[]).map((r) => r.check_id));
    const counts = new Map<string, number>([...original].map((c) => [c, 0]));
    let clean = 0;
    for (const r of repeats.filter((r) => r.state === "settled")) {
      const checks = this.checks(r.trace_id!);
      if (!checks.size && !r.execution_failed && r.agent_status === "ok") clean++;
      for (const c of checks) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const count = (state: BatchRepeat["state"]) => repeats.filter((r) => r.state === state).length;
    return { ...b, repeats, linked: repeats.filter((r) => r.trace_id).length, settled: count("settled"), clean,
      pending: count("pending") + count("running") + count("queued"), failed: count("failed"), unlinked: count("unlinked") + repeats.filter((r) => r.state === "failed" && !r.trace_id).length, cancelled: count("cancelled"),
      execution_failed: repeats.filter((r) => r.execution_failed).length,
      evaluation_failed: repeats.filter((r) => r.state === "failed" && r.trace_id !== null).length,
      findings: [...counts].sort(([a], [c]) => a.localeCompare(c)).map(([check_id, count]) => ({ check_id, count, original: original.has(check_id) })) };
  }

  private checks(trace: string): Set<string> {
    const errors = new Set((this.roots.store.db.prepare("SELECT finding_id FROM replay_evaluation_failures WHERE trace_id=?").all(trace) as { finding_id: string }[]).map((r) => r.finding_id));
    return new Set([...this.roots.store.findingsForTrace(trace).filter((f) => f.status !== "failed" && !(f.check_kind === "question" && f.probability === null && f.detail?.error) && !errors.has(f.id)).map((f) => f.check_id),
      ...(this.roots.store.db.prepare("SELECT check_id FROM replay_observations WHERE trace_id=?").all(trace) as { check_id: string }[]).map((r) => r.check_id)]);
  }
  close(): void {
    if (this.closed || !this.roots.store.db.open) return;
    this.roots.store.db.prepare("UPDATE replay_batches SET state='interrupted',error='server shutdown',finished_ms=? WHERE state IN ('running','cancelling')").run(Date.now());
    for (const id of this.active) { const summary = this.get(id); if (summary) this.snapshots.set(id, summary); }
    this.closed = true;
    this.stop();
  }
  forRun(traceId: string): BatchSummary[] {
    if (this.closed || !this.roots.store.db.open) return [];
    return (this.roots.store.db.prepare("SELECT id FROM replay_batches WHERE trace_id=? ORDER BY created_ms DESC LIMIT 50").all(traceId) as { id: string }[]).map((r) => this.get(r.id)!);
  }
}
