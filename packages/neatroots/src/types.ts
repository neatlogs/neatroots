import type { Plain } from "./otlp/types.js";
import type { SpanKind } from "./semantics/view.js";

export type RunStatus = "running" | "ok" | "error" | "interrupted";

export interface RunRow {
  trace_id: string;
  session_id: string | null;
  project: string | null;
  workflow: string | null;
  root_span_id: string | null;
  root_name: string | null;
  status: RunStatus;
  complete: number;
  root_ended: number;
  started_ms: number | null;
  ended_ms: number | null;
  last_span_ms: number | null;
  span_count: number;
  llm_calls: number;
  tool_calls: number;
  error_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  input_preview: string | null;
  output_preview: string | null;
  interrupted: number;
  termination_reason: string | null;
  finding_count: number;
  open_finding_count: number;
  pinned: number;
  doctor: number;
  imported: number;
  plan_id: string | null;
  received_ms: number;
  updated_ms: number;
}

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  span_kind: SpanKind;
  otel_kind: number;
  start_ns: string;
  end_ns: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  status_code: number;
  status_message: string | null;
  model: string | null;
  provider: string | null;
  tool_name: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  input_preview: string | null;
  output_preview: string | null;
  error: string | null;
  is_marker: number;
  resource_id: string;
  scope_id: string;
  received_ms: number;
  seq: number;
}

/** quiet: open, but not counted, because the person kept dismissing this check in this project. */
export type FindingStatus = "raised" | "active" | "resolved" | "dismissed" | "failed" | "quiet";

export interface Finding {
  id: string;
  trace_id: string;
  check_id: string;
  check_kind: "rule" | "question";
  title: string;
  probability: number | null;
  status: FindingStatus;
  evidence_span_ids: string[];
  detail: Record<string, Plain>;
  model: string | null;
  triage_score: number | null;
  explanation_id: string | null;
  created_ms: number;
  updated_ms: number;
}

export interface Explanation {
  id: string;
  target_type: "finding" | "run";
  target_id: string;
  trace_id: string;
  cause: string;
  fix: string | null;
  evidence_span_ids: string[];
  grounding: number | null;
  model: string | null;
  created_ms: number;
}

export type NoteStatus = "pending" | "delivered" | "superseded" | "blocked" | "expired";

export interface Note {
  id: string;
  trace_id: string;
  finding_id: string | null;
  kind: "template" | "llm" | "halt";
  text: string;
  status: NoteStatus;
  created_ms: number;
  delivered_ms: number | null;
  delivered_span_id: string | null;
  replaced_by: string | null;
  checks: Record<string, Plain> | null;
}

export interface Annotation {
  id: string;
  trace_id: string;
  span_id: string | null;
  label: "issue" | "good" | "note";
  text: string | null;
  author: string;
  created_ms: number;
}

export interface ForwardRow {
  id: string;
  trace_ids: string[];
  endpoint: string;
  status: "ok" | "error" | "pending";
  http_status: number | null;
  span_count: number;
  bytes: number;
  redactions: number;
  error: string | null;
  initiated_by: string;
  created_ms: number;
}

export interface PlanRow {
  id: string;
  workflow: string;
  created_ms: number;
  created_by: "planner" | "default" | "user";
  model: string | null;
  rationale: string | null;
  check_ids: string[];
  /** Values the planner filled in per check. */
  params: Record<string, Record<string, string>>;
  /** Tools the agent had when the plan was made; new tools trigger a new plan. */
  tools: string[];
}

export interface DecisionRow {
  id: string;
  trace_id: string;
  check_id: string;
  span_id: string | null;
  probability: number;
  answer: Plain;
  backend: string;
  latency_ms: number;
  created_ms: number;
}
