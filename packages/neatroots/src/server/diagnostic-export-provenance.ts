import { isQuestion, type LoadedCheck } from "../checks/types.js";
import type { Plain } from "../otlp/types.js";

/** Location/source is not authorship: planner/draft/MCP bodies can be adopted into user files.
 * Keep curated library bodies only; project/user/generated entries retain explicit metadata. */
export function exportDefinition(current: LoadedCheck | undefined, alias: string): Record<string, unknown> {
  if (!current) return { definition: null, check_kind: null };
  const check = current.check;
  if (current.source !== "library") {
    const summary = check.kind === "rule" ? Object.fromEntries(Object.entries(check.rule).filter(([key, value]) =>
      typeof value === "number" || typeof value === "boolean" || ["type", "metric", "field", "when", "same"].includes(key))) : null;
    return { definition: null, definition_omitted: "unverified-provenance", check_kind: check.kind, rule_summary: summary };
  }
  const { title: _title, ...question } = check;
  return { check_kind: check.kind, definition: isQuestion(check) ? { ...question, id: alias } : { ...check, id: alias, ...(check.title === check.id ? { title: alias } : {}) } };
}

/** Actual producers write span identity and backend/source metadata here. Choice/group/params,
 * quotes/errors and unknown detail members can be derived from clipped/model-produced text. */
export function exportDetail(detail: Record<string, Plain>): Record<string, Plain> {
  const out: Record<string, Plain> = {};
  if (typeof detail.span_id === "string" || detail.span_id === null) out.span_id = detail.span_id;
  if (Array.isArray(detail.occurrences) && detail.occurrences.every((v) => typeof v === "string")) out.occurrences = detail.occurrences;
  if (typeof detail.source === "string" && ["library", "user", "project", "planner", "mcp"].includes(detail.source)) out.source = detail.source;
  if (typeof detail.backend === "string") out.backend = detail.backend;
  return out;
}
