import type { Finding } from "@/lib/api";

export const VERDICTS = { correct: "Confirmed problem", incorrect: "False positive", uncertain: "Unsure" } as const;
export const REVIEW_LABELS = { unreviewed: "Not reviewed", stale: "Needs review again", ...VERDICTS } as const;
export type Verdict = keyof typeof VERDICTS;
export interface ReviewItem {
  finding: Pick<Finding, "id" | "trace_id" | "check_id" | "check_kind" | "title" | "status" | "evidence_span_ids" | "detail">;
  project: string | null;
  run_name: string | null;
  evidence_version: string;
  state: keyof typeof REVIEW_LABELS;
  review: { verdict: Verdict; reason: string; source: "human" | "tool"; updated_ms: number } | null;
}
export interface ReviewQueue { items: ReviewItem[]; total: number; next_cursor: string | null }
