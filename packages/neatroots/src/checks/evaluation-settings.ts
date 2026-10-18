import type { QuestionCheck } from "./types.js";

/** The same threshold used by the verdict and its recorded provenance. */
export function flagThreshold(check: QuestionCheck, backend: string): number {
  if (check.kind === "score") return check.flag_at_level;
  return backend === "llm" ? Math.min(check.flag_at, 0.88) : check.flag_at;
}

export function evaluationSettings(check: QuestionCheck, backend: string) {
  return {
    contract: "neatroots.flagged.v1",
    comparator: ">=",
    threshold: flagThreshold(check, backend),
    metric: check.kind === "score" ? "expected_level" : check.kind === "choice" ? "flag_on_probability_sum" : "yes_probability",
    ...(check.kind === "choice" ? { flag_on: [...check.flag_on] } : {}),
  };
}
