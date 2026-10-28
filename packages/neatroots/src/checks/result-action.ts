import type { RuleSpec } from "./types.js";
import type { RuleHit } from "./rules.js";
import { selectSpans, type SpanInfo, type TraceSnapshot } from "../engine/trace.js";

type Contract = Extract<RuleSpec, { type: "result_action" }>;
type Scalar = string | number | boolean | null;
export interface ContractCoverage {
  actions: number;
  evaluated: number;
  matched: number;
  skipped: Record<string, number>;
}
const MAX_COMPARISONS = 100_000;

function valueAt(output: unknown, path: (string | number)[]): { value: unknown } | undefined {
  let value = output;
  for (const key of path) {
    if (!value || typeof value !== "object") return;
    if (typeof key === "number" ? !Array.isArray(value) : Array.isArray(value) || ["__proto__", "prototype", "constructor"].includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value === undefined ? undefined : { value };
}
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function completed(s: SpanInfo): boolean {
  return Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.startMs >= 0 && s.endMs >= s.startMs && s.endMs > 0 && s.endMs <= Number.MAX_SAFE_INTEGER;
}
function correlation(s: SpanInfo, field: { field: "input" | "output"; path: (string | number)[] }): string | undefined {
  const found = valueAt(s[field.field], field.path);
  return found && scalar(found.value) ? `${typeof found.value}:${JSON.stringify(found.value)}` : undefined;
}

/** All indexes are local to this snapshot. Parent ids never join different traces. */
export function evaluateResultAction(rule: Contract, trace: TraceSnapshot): { hit: RuleHit | null; coverage: ContractCoverage } {
  const results = selectSpans(trace.spans, rule.result);
  const actions = selectSpans(trace.spans, rule.forbids).sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  const coverage: ContractCoverage = { actions: actions.length, evaluated: 0, matched: 0, skipped: {} };
  const skip = (reason: string): void => { coverage.skipped[reason] = (coverage.skipped[reason] ?? 0) + 1; };
  const byParent = new Map<string, SpanInfo[]>();
  for (const result of results) {
    if (!result.parentId) continue;
    const group = byParent.get(result.parentId) ?? [];
    group.push(result);
    byParent.set(result.parentId, group);
  }
  const ids = new Set<string>();
  const duplicate = trace.spans.some((s) => { const seen = ids.has(s.id); ids.add(s.id); return seen; });
  const comparisons = actions.reduce((n, a) => n + (byParent.get(a.parentId ?? "")?.length ?? 0), 0);
  let last: { result: SpanInfo; action: SpanInfo; delta: number } | undefined;
  for (const action of actions) {
    if (duplicate) { skip("duplicate_span_id"); continue; }
    if (comparisons > MAX_COMPARISONS) { skip("comparison_budget"); continue; }
    if (!action.parentId) { skip("unknown_parent"); continue; }
    if (!completed(action)) { skip("invalid_action_time"); continue; }
    let candidates = (byParent.get(action.parentId) ?? []).filter((s) => s.id !== action.id);
    if (rule.correlate) {
      const key = correlation(action, rule.correlate.action);
      if (key === undefined) { skip("action_correlation_missing"); continue; }
      const relevant = candidates.filter((s) => !Number.isFinite(s.startMs) || s.startMs <= action.startMs);
      if (relevant.some((s) => correlation(s, rule.correlate!.result) === undefined)) { skip("result_correlation_missing"); continue; }
      candidates = candidates.filter((s) => correlation(s, rule.correlate!.result) === key);
    }
    if (candidates.some((s) => !Number.isFinite(s.startMs))) { skip("invalid_result_time"); continue; }
    const started = candidates.filter((s) => s.startMs <= action.startMs);
    if (started.some((s) => !completed(s))) { skip("incomplete_result"); continue; }
    if (started.some((s) => s.endMs >= action.startMs)) { skip("overlap_or_equal_boundary"); continue; }
    const preceding = started.sort((a, b) => b.endMs - a.endMs);
    const result = preceding[0];
    if (!result) { skip("no_preceding_result"); continue; }
    if (preceding[1]?.endMs === result.endMs) { skip("ambiguous_result_order"); continue; }
    const delta = action.startMs - result.endMs;
    if (delta > rule.within_ms) { skip("outside_window"); continue; }
    const observed = valueAt(result.output, rule.path);
    if (!observed || !scalar(observed.value)) { skip("result_value_missing_or_not_scalar"); continue; }
    if (typeof observed.value !== typeof rule.equals || (observed.value === null) !== (rule.equals === null)) { skip("result_value_type_mismatch"); continue; }
    coverage.evaluated++;
    if (observed.value !== rule.equals) continue;
    last = { result, action, delta };
    coverage.matched++;
  }
  return {
    coverage,
    hit: last ? {
      firing: true,
      evidenceSpanIds: [last.result.id, last.action.id],
      title: "Recorded result/action contract matched",
      params: {
        result_tool: last.result.toolName ?? last.result.name,
        action_tool: last.action.toolName ?? last.action.name,
        delta_ms: String(last.delta),
        path: JSON.stringify(rule.path),
        value: JSON.stringify(rule.equals),
        within_ms: String(rule.within_ms),
        count: String(coverage.matched),
      },
    } : null,
  };
}

export function resultActionHit(rule: Contract, trace: TraceSnapshot): RuleHit | null {
  return evaluateResultAction(rule, trace).hit;
}
