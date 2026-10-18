/** Opt-in state for one fixture case. Ordinary checking keeps its existing state/contract. */
export interface RuleEvaluation {
  check_id: string;
  status: "evaluated" | "unevaluated" | "error";
  reason: string;
}

export interface EvaluationContext {
  tooSlow: Set<string>;
  matchMemo: Map<string, boolean>;
  outcome: RuleEvaluation;
}

export function createEvaluationContext(): EvaluationContext {
  return { tooSlow: new Set(), matchMemo: new Map(), outcome: { check_id: "", status: "evaluated", reason: "complete" } };
}

export function beginEvaluation(context: EvaluationContext, checkId: string): void {
  context.outcome = { check_id: checkId, status: "evaluated", reason: "complete" };
}

/** Keep the first incomplete reason, but errors always take precedence. No trace text is stored. */
export function recordEvaluation(context: EvaluationContext | undefined, status: RuleEvaluation["status"], reason: string): void {
  if (!context || context.outcome.status === "error") return;
  if (status === "error" || context.outcome.status === "evaluated") context.outcome = { ...context.outcome, status, reason };
}

/** Messages constructed by suite code from controlled categories and explicit input identities. */
export class SuiteInputError extends Error {}

export function suiteErrorMessage(error: unknown): string {
  return error instanceof SuiteInputError ? error.message : "input could not be read or evaluated";
}
