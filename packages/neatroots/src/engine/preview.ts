import type { Roots } from "../core.js";
import { isRule, type QuestionCheck, type RuleCheck } from "../checks/types.js";
import { evaluateRule } from "../checks/rules.js";
import { DecisionUnavailableError, type DecisionModel, type DecisionQuestion, type DecisionResult } from "../models/decision.js";
import { buildEvidence, loadTrace, selectSpans } from "./trace.js";

export interface PreviewOptions { limit?: number; workflow?: string; project?: string; timeBudgetMs?: number; signal?: AbortSignal }
export interface PreviewRunResult {
  trace_id: string;
  root_name: string | null;
  status: "hit" | "clear" | "skipped" | "error";
  reason?: "no_hit" | "no_evidence" | "model_error" | "aborted" | "time_budget";
  evaluation?: { targets_available: number; targets_considered: number; targets_attempted: number; targets_evaluated: number; complete: boolean; target_limit: number; stop_reason?: string };
}
export interface FilteredPreviewRun {
  trace_id: string; root_name: string | null; status: "filtered"; reason: "running" | "applies_to" | "limit";
}

// Only absorb arithmetic endpoint noise, never materially out-of-range verdicts.
const ENDPOINT_TOLERANCE = 1e-12;
const inRange = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= -ENDPOINT_TOLERANCE && value <= max + ENDPOINT_TOLERANCE;
const probability = (value: unknown): value is number => inRange(value, 1);
const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));

/** Validate only the typed verdict consumed here; raw provider normalization belongs to the backend. */
function usableVerdict(check: QuestionCheck, result: DecisionResult): boolean {
  const answer = result?.answers?.[check.id];
  if (!answer || typeof answer !== "object" || Array.isArray(answer) || !probability(answer.probability)) return false;
  if (answer.type !== undefined && answer.type !== check.kind) return false;
  if (check.kind === "score") return inRange(answer.score, check.levels.length - 1);
  if (check.kind === "choice") {
    const distribution = answer.distribution;
    if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) return false;
    const keys = Object.keys(check.options);
    return Object.keys(distribution).length === keys.length && keys.every((key) => probability(distribution[key]))
      && Math.abs(keys.reduce((sum, key) => sum + distribution[key], 0) - 1) < 1e-6;
  }
  return true;
}

/** Interactive preview only: no findings, live scheduling, or second-look calls. */
export async function previewCheck(
  roots: Roots, decisions: DecisionModel, check: QuestionCheck | RuleCheck, opts: PreviewOptions,
  appliesTo: (run: { project: string; workflow: string }) => boolean,
  question: (check: QuestionCheck) => DecisionQuestion,
  flagged: (check: QuestionCheck, result: DecisionResult) => { flagged: boolean; probability: number },
) {
  const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(opts.limit) ? opts.limit! : 50)));
  // Only runs the check would watch: the engine skips runs outside its applies_to, so a preview
  // over them would report hits the check can never raise. Look further back to still fill `limit`.
  const candidateLimit = check.applies_to ? 500 : limit;
  // Request project/workflow filters stay inside the query: excluded rows never cross that boundary.
  const candidates = roots.store.listRuns({ workflow: opts.workflow, project: opts.project, limit: candidateLimit });
  const runs: typeof candidates = [];
  const filtered_results: FilteredPreviewRun[] = [];
  for (const run of candidates) {
    const reason = run.status === "running" ? "running"
      : !appliesTo({ project: run.project ?? "unknown", workflow: run.workflow ?? run.project ?? "unknown" }) ? "applies_to"
      : runs.length >= limit ? "limit" : undefined;
    if (reason) filtered_results.push({ trace_id: run.trace_id, root_name: run.root_name, status: "filtered", reason });
    else runs.push(run);
  }
  const deadline = Date.now() + (opts.timeBudgetMs ?? 90_000);
  const hits: { trace_id: string; probability: number | null; evidence_span_ids: string[]; root_name: string | null }[] = [];
  const skipped: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const results: PreviewRunResult[] = [];
  let checked = 0;
  let stopped: "aborted" | "time_budget" | undefined;
  const count = (counts: Record<string, number>, reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; };
  for (const r of runs) {
    if (!stopped) {
      if (opts.signal?.aborted) stopped = "aborted";
      else if (Date.now() > deadline) stopped = "time_budget";
    }
    if (stopped) {
      count(skipped, stopped);
      results.push({ trace_id: r.trace_id, root_name: r.root_name, status: "skipped", reason: stopped });
      continue;
    }
    const snap = loadTrace(roots.store, r.trace_id);
    if (isRule(check)) {
      // Draft patterns retain main's bounded, untrusted evaluation path.
      const hit = evaluateRule(check, snap, true, undefined, true);
      if (hit && !hit.satisfied) {
        checked++;
        hits.push({ trace_id: r.trace_id, probability: null, evidence_span_ids: hit.evidenceSpanIds, root_name: r.root_name });
        results.push({ trace_id: r.trace_id, root_name: r.root_name, status: "hit" });
      } else {
        checked++;
        results.push({ trace_id: r.trace_id, root_name: r.root_name, status: "clear", reason: "no_hit" });
      }
      continue;
    }
    const available = check.scope === "span" ? selectSpans(snap.spans, check.evidence?.spans) : [undefined];
    const targets = available.slice(-5);
    let attempted = 0, successful = 0;
    let evaluated = false;
    let noEvidence = targets.length === 0;
    let modelError = false;
    let foundHit = false;
    let interrupted: "aborted" | "time_budget" | undefined;
    for (const focus of targets) {
      if (opts.signal?.aborted) { interrupted = "aborted"; break; }
      if (Date.now() > deadline) { interrupted = "time_budget"; break; }
      const ev = buildEvidence(snap, check.evidence, { focus });
      if (!ev.spanIds.length && !check.evidence?.final_output) {
        noEvidence = true;
        continue;
      }
      try {
        attempted++;
        const res = await decisions.decide(ev.text, [question(check)], { priority: "interactive", signal: opts.signal });
        if (!usableVerdict(check, res)) throw new Error("unusable preview verdict");
        const answer = res.answers[check.id];
        const normalized = { ...answer, probability: clamp(answer.probability),
          ...(check.kind === "score" ? { score: clamp(answer.score!, check.levels.length - 1) } : {}),
        };
        const v = flagged(check, { ...res, answers: { ...res.answers, [check.id]: normalized } });
        if (typeof v?.flagged !== "boolean" || !probability(v.probability)) throw new Error("unusable preview verdict");
        evaluated = true;
        successful++;
        if (v.flagged) {
          hits.push({ trace_id: r.trace_id, probability: clamp(v.probability), evidence_span_ids: ev.spanIds, root_name: r.root_name });
          foundHit = true;
          break;
        }
      } catch (err) {
        if (err instanceof DecisionUnavailableError) throw err;
        if (opts.signal?.aborted) { interrupted = "aborted"; break; }
        modelError = true;
      }
    }
    const evaluation = {
      targets_available: available.length, targets_considered: targets.length,
      targets_attempted: attempted, targets_evaluated: successful, target_limit: 5,
      complete: !interrupted && !modelError && !noEvidence && successful === available.length,
      stop_reason: interrupted ?? (foundHit && attempted < targets.length ? "hit" : modelError ? "model_error" : noEvidence ? "no_evidence" : available.length > targets.length ? "target_limit" : undefined),
    };
    if (foundHit) {
      checked++;
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "hit" });
    } else if (interrupted) {
      stopped = interrupted;
      count(skipped, interrupted);
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "skipped", reason: interrupted });
    } else if (modelError) {
      count(errors, "model_error");
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "error", reason: "model_error" });
    } else if (noEvidence) {
      count(skipped, "no_evidence");
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "skipped", reason: "no_evidence" });
    } else if (evaluated) {
      checked++;
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "clear", reason: "no_hit" });
    } else {
      count(skipped, "no_evidence");
      results.push({ trace_id: r.trace_id, root_name: r.root_name, evaluation, status: "skipped", reason: "no_evidence" });
    }
  }
  return { checked, hits, skipped, errors, results, total: runs.length, truncated: stopped !== undefined,
    second_look: false as const, evaluation_mode: isRule(check) ? "deterministic_rule" as const : "question_without_second_look" as const,
    selection: { candidate_limit: candidateLimit, candidate_count: candidates.length, selected_count: runs.length, window_full: candidates.length === candidateLimit },
    filtered_results,
  };
}
