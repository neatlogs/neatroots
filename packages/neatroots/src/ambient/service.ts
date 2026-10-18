import type { Bus } from "../bus.js";
import type { Store } from "../store/db.js";
import type { RunRow } from "../types.js";
import type { AmbientChecks, AmbientConfig, AmbientOutput, AmbientSignal, AmbientState } from "./types.js";

const LOOPS = new Set(["repeated-tool-call", "tool-error-streak", "runaway-loop", "unrecovered-tool-failure", "tool-cycle"]);
const PRIORITY: Record<AmbientState, number> = { error: 0, loop: 1, interrupted: 2, attention: 3, live: 4, checking: 5, incomplete: 6, success: 7, idle: 8, inactive: 9 };
const empty = (state: "inactive" | "idle"): AmbientSignal => ({ state, trace_id: null, project: null, workflow: null, active_runs: 0 });

/** One owner per server. Polling observes check receipts even when no new span event arrives. */
export class AmbientService {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private readonly observed = new Set<string>();
  private readonly transitions = new Map<string, { state: AmbientState; at: number }>();
  private current = empty("inactive");
  private outputError = false;
  private config: AmbientConfig = { enabled: false, outputs: { log: { enabled: false } } };

  constructor(private readonly store: Store, private readonly bus: Bus, private readonly output: AmbientOutput,
    private readonly checks: (traceId: string) => AmbientChecks = () => "unknown") {}

  configure(config: AmbientConfig): void {
    this.config = config;
    const enabled = config.enabled === true && (config.outputs.log.enabled === true || config.outputs.chroma?.enabled === true);
    if (!enabled) { this.stop(); return; }
    if (!this.unsubscribe) {
      // All live runs, plus the latest result; do not replay the rest of historical outcomes.
      const rows = this.store.db.prepare("SELECT trace_id FROM runs WHERE doctor = 0 AND status = 'running' UNION SELECT trace_id FROM (SELECT trace_id FROM runs WHERE doctor = 0 ORDER BY received_ms DESC, trace_id ASC LIMIT 1)").all() as { trace_id: string }[];
      for (const r of rows) this.observed.add(r.trace_id);
      this.unsubscribe = this.bus.onAny(({ payload }) => {
        const p = payload as { trace_id?: string; traceId?: string } | undefined;
        const id = p?.trace_id ?? p?.traceId;
        if (typeof id === "string") this.observed.add(id);
        this.refresh();
      });
      this.timer = setInterval(() => this.refresh(), 250);
      this.timer.unref();
    }
    this.refresh();
  }

  status() {
    return { ...this.current, enabled: this.config.enabled === true, log_enabled: this.config.outputs.log.enabled === true,
      subscribed: !!this.unsubscribe, output_error: this.outputError };
  }

  private state(run: RunRow): AmbientState {
    if (run.status === "error") return "error";
    if (run.status === "interrupted" || run.interrupted) return "interrupted";
    const findings = this.store.findingsForTrace(run.trace_id);
    const open = findings.filter((f) => f.status === "raised" || f.status === "active");
    if (open.some((f) => LOOPS.has(f.check_id))) return "loop";
    if (open.length) return "attention";
    if (run.status === "running") return "live";
    const checks = this.checks(run.trace_id);
    if (checks === "checking") return "checking";
    // A missing receipt, an interrupted/failed check, or an invalid registry cannot prove success.
    if (checks !== "settled" || findings.some((f) => f.status === "failed")) return "incomplete";
    return "success";
  }

  private refresh(): void {
    try { this.update(); } catch { this.outputError = true; }
  }

  private update(): void {
    if (!this.unsubscribe || !this.store.db.open) return;
    const runs = [...this.observed].flatMap((id) => {
      const run = this.store.getRun(id);
      if (!run || run.doctor) { this.observed.delete(id); this.transitions.delete(id); return []; }
      const state = this.state(run);
      const previous = this.transitions.get(id);
      if (!previous || previous.state !== state) this.transitions.set(id, { state, at: Date.now() });
      const since = this.transitions.get(id)!.at;
      const terminal = run.status !== "running" && state !== "checking";
      const expired = terminal && Date.now() - since >= (state === "success" ? 10_000 : 30_000);
      return [{ run, state, expired }];
    });
    // Current work wins over finished history. Among live runs, prioritize findings; immutable
    // arrival/ID breaks ties. With no active work, only the newest run may display its outcome.
    const byArrival = (a: { run: RunRow }, b: { run: RunRow }) => b.run.received_ms - a.run.received_ms || a.run.trace_id.localeCompare(b.run.trace_id);
    const active = runs.filter(({ run, state }) => run.status === "running" || state === "checking");
    active.sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || byArrival(a, b));
    const newest = runs.sort(byArrival)[0];
    const chosen = active[0] ?? (newest && !newest.expired ? newest : undefined);
    this.publish(chosen ? { state: chosen.state, trace_id: chosen.run.trace_id, project: chosen.run.project,
      workflow: chosen.run.workflow, active_runs: active.length } : empty("idle"));
    // Retain every active run and only the latest 64 outcomes (bounded history for a long-lived server).
    const completed = [...this.observed].flatMap((id) => {
      const run = this.store.getRun(id);
      return run ? [{ run, state: this.state(run) }] : [];
    }).filter(({ run, state }) => run.status !== "running" && state !== "checking")
      .sort((a, b) => b.run.received_ms - a.run.received_ms || a.run.trace_id.localeCompare(b.run.trace_id));
    for (const { run } of completed.slice(64)) { this.observed.delete(run.trace_id); this.transitions.delete(run.trace_id); }
  }

  private publish(signal: AmbientSignal): void {
    if (JSON.stringify(signal) === JSON.stringify(this.current)) return;
    this.current = signal;
    try { this.output.setState(signal); this.outputError = false; }
    catch { this.outputError = true; } // Never log the exception, which may contain output-specific data.
  }

  close(): void { this.stop(); }

  private stop(): void {
    const active = !!this.unsubscribe;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    clearInterval(this.timer); this.timer = undefined;
    this.observed.clear();
    this.transitions.clear();
    if (active) this.publish(empty("inactive"));
    else this.current = empty("inactive");
    this.outputError = false;
  }
}
