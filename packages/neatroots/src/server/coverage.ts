import type { Roots } from "../core.js";

// How much of a run has actually been checked, so "nothing found" is only shown as a clean result
// when the questions really ran. Rules always run; questions need a decision model.

export interface CheckCoverage {
  /**
   * checking: work is queued or running. done: every question for the run has an answer.
   * rules-only: no model could answer questions. partial: some questions failed or were never
   * asked. interrupted: a restart stopped the work and it wasn't resumed.
   */
  state: "checking" | "done" | "rules-only" | "partial" | "interrupted";
  /** Questions in force for this run (its plan, baseline questions, your own checks). */
  questions: number;
  answered: number;
  /** Questions whose model call failed (a timeout or an error, never counted as a "no"). */
  failed: number;
  /** Check jobs still queued or running for the run. */
  pending: number;
  model: { available: boolean; backend: string | null };
}

export async function checkCoverage(roots: Roots, traceId: string): Promise<CheckCoverage | null> {
  const engine = roots.engine;
  const run = roots.store.getRun(traceId);
  if (!engine || !run) return null;
  const plan = run.plan_id ? roots.store.getPlan(run.plan_id) : undefined;
  const ids = new Set(engine.questionsFor({ project: run.project ?? "unknown", workflow: run.workflow ?? run.project ?? "unknown", plan }).map((q) => q.check.id));
  const answered = new Set(roots.store.decisionsForTrace(traceId).filter((d) => ids.has(d.check_id)).map((d) => d.check_id));
  const failed = new Set(roots.store.findingsForTrace(traceId).filter((f) => f.status === "failed" && ids.has(f.check_id) && !answered.has(f.check_id)).map((f) => f.check_id));
  const pending = engine.pending(traceId);
  const status = await engine.decisions.status().catch(() => ({ backend: null as string | null }));
  const available = !!status.backend;
  const progress = engine.progress.state(traceId);
  let state: CheckCoverage["state"];
  if (pending > 0 || progress === "checking" || (run.status === "running" && available)) state = "checking";
  else if (progress === "interrupted") state = "interrupted";
  else if (answered.size >= ids.size) state = "done";
  else if (!available && answered.size === 0) state = "rules-only";
  else state = "partial";
  return { state, questions: ids.size, answered: answered.size, failed: failed.size, pending, model: { available, backend: status.backend } };
}
