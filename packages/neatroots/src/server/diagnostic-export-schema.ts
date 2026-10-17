import { RuleSpec, EvidenceField } from "../checks/types.js";
import type { RunStatus } from "../types.js";

const RUN_STATUSES: Record<RunStatus, true> = { running: true, ok: true, error: true, interrupted: true };
const RULE_TYPES = new Set<string>(RuleSpec.options.map((option) => option.shape.type.value));
const METRICS: Record<Extract<RuleSpec, { type: "threshold" }>["metric"], true> = { total_tokens: true, prompt_tokens: true, completion_tokens: true, llm_calls: true, tool_calls: true, duration_ms: true, span_count: true };
const FIELDS: Record<Extract<RuleSpec, { type: "match" }>["field"], true> = { input: true, output: true, error: true, name: true };
const SAME: Record<Extract<RuleSpec, { type: "repeat" }>["same"][number], true> = { name: true, tool: true, input: true, output: true, status: true };
const METADATA_KEYS: Record<string, string> = { definition_omitted: "bundle.checks.current_definitions[]", rule_summary: "bundle.checks.current_definitions[]", params_provenance: "bundle.checks.historical", answer_omitted: "bundle.checks.decisions[]" };

// Schema positions, not property spellings, distinguish fixed values from user data.
// These names describe the bundle and OTLP wire shape. Data map keys are still redacted.
const STRUCTURAL_KEYS = new Set([
  "format", "schema_version", "version", "neatroots", "run", "trace", "findings", "checks", "redactions", "applied",
  "rule_source", "scope", "matches", "kind", "count", "trace_id", "session_id", "project", "workflow",
  "root_span_id", "root_name", "status", "started_ms", "ended_ms", "span_count", "llm_calls", "tool_calls", "error_count",
  "prompt_tokens", "completion_tokens", "total_tokens", "input_preview", "output_preview", "interrupted", "termination_reason",
  "id", "check_id", "check_kind", "title", "probability", "evidence_span_ids", "detail", "model", "triage_score", "created_ms",
  "updated_ms", "explanation", "explanation_id", "cause", "fix", "grounding", "plan", "plan_available", "plan_id", "available",
  "recorded_check_ids", "historical_definitions", "definition_available", "note", "current_definitions", "source", "definition", "enabled_now", "currently_applicable_rule",
  "decisions", "span_id", "answer", "backend", "latency_ms", "resourceSpans", "resource", "scopeSpans", "spans", "attributes",
  "key", "value", "stringValue", "boolValue", "intValue", "doubleValue", "bytesValue", "arrayValue", "values", "kvlistValue",
  "droppedAttributesCount", "schemaUrl", "name", "scope", "traceId", "spanId", "parentSpanId", "traceState", "flags",
  "startTimeUnixNano", "endTimeUnixNano", "events", "droppedEventsCount", "links", "droppedLinksCount", "timeUnixNano", "code",
  "message", "description", "enabled", "baseline", "applies_to", "guidance", "tags", "group", "ask", "when", "params", "options",
  "flag_on", "flag_at", "levels", "flag_at_level", "rule", "type", "same", "at_least", "consecutive", "at_least_ms", "metric",
  "requires", "min_calls", "rising", "factor", "min_tokens", "max_period", "min_cycles", "goal", "final_output", "last", "fields",
  "tool", "start", "end", "duration_ms", "error", "input", "output", "tokens", "rootInput", "system", "user", "content", "role",
  "arguments", "state", "choice", "confidence", "score", "params_provenance", "definition_omitted", "rule_summary", "answer_omitted", "evidence", "action", "pattern", "field",
]);

const SOURCES = ["library", "user", "project", "planner", "mcp"];
export function dataMap(path: string): boolean {
  return path.endsWith(".params") || path.endsWith(".options") || path.startsWith("bundle.checks.historical.params.");
}
export function structuralKey(path: string, key: string): boolean {
  if (key === "exported_at") return path === "bundle";
  if (key === "historical") return path === "bundle.checks";
  if (key === "occurrences") return path.replace(/\[\d+\]/g, "[]") === "bundle.findings[].detail";
  if (Object.hasOwn(METADATA_KEYS, key)) return path.replace(/\[\d+\]/g, "[]") === METADATA_KEYS[key];
  return !dataMap(path) && STRUCTURAL_KEYS.has(key);
}
export function fixedString(path: string, value: string): boolean {
  const p = path.replace(/\[\d+\]/g, "[]");
  const exact: Record<string, readonly string[]> = {
    "bundle.format": ["neatroots.diagnostic-export"], "bundle.trace.format": ["otlp-json"],
    "bundle.run.status": Object.keys(RUN_STATUSES),
    "bundle.checks.historical.historical_definitions": ["not-retained"],
    "bundle.checks.historical.params_provenance": ["user", "planner", "default", "unavailable"],
    "bundle.redactions.rule_source": ["cloud_forwarding"],
  };
  if (exact[p]?.includes(value)) return true;
  if (["bundle.exported_at", "bundle.redactions.scope", "bundle.checks.historical.note", "bundle.version.neatroots"].includes(p)) return true; // application-authored constants
  if (p === "bundle.findings[].check_kind") return ["rule", "question"].includes(value);
  if (p === "bundle.findings[].status") return ["raised", "active", "resolved", "dismissed", "failed", "quiet"].includes(value);
  if (/^bundle\.findings\[\]\.detail\.source$/.test(p) || /^bundle\.checks\.current_definitions\[\]\.source$/.test(p)) return SOURCES.includes(value);
  if (/^bundle\.checks\.current_definitions\[\]\.definition_omitted$/.test(p)) return value === "unverified-provenance";
  if (/^bundle\.checks\.current_definitions\[\]\.(check_kind|definition\.kind)$/.test(p)) return ["rule", "yes_no", "choice", "score"].includes(value);
  const d = p.replace(/^bundle\.checks\.current_definitions\[\]\.(definition|rule_summary)/, "$1");
  if (d === "definition.scope") return ["trace", "span", "session"].includes(value);
  if (d === "definition.when") return ["live", "end"].includes(value);
  if (d === "definition.action") return ["flag", "halt"].includes(value);
  if (/^(definition\.rule|rule_summary)\.type$/.test(d)) return RULE_TYPES.has(value);
  if (/^(definition\.rule|rule_summary)\.when$/.test(d)) return ["error", "no_output", "interrupted"].includes(value);
  if (/^(definition\.rule|rule_summary)\.metric$/.test(d)) return Object.hasOwn(METRICS, value);
  if (/^(definition\.rule|rule_summary)\.field$/.test(d)) return Object.hasOwn(FIELDS, value);
  if (/^(definition\.rule|rule_summary)\.same\[\]$/.test(d)) return Object.hasOwn(SAME, value);
  if (d === "definition.evidence.fields[]") return (EvidenceField.options as readonly string[]).includes(value);
  if (/^definition\.(evidence\.spans|rule\.(span|requires))\.status$/.test(d)) return ["ok", "error", "unset", "any"].includes(value);
  return false;
}
