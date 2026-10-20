import type Database from "better-sqlite3";
import { kvToPlain, type KeyValue } from "../otlp/types.js";
import { addCost, emptyCost, priceCall, type CostEstimate, type Price } from "../models/pricing.js";

export interface CostGroups { total: CostEstimate; runs: Map<string, CostEstimate>; models: Map<string, CostEstimate> }
/** The caller supplies a run predicate, not a page of run IDs. No row limit can truncate costs. */
export function readCosts(db: Database.Database, predicate: string, params: Record<string, unknown>, prices: Price[] = []): CostGroups {
  const groups: CostGroups = { total: emptyCost(), runs: new Map(), models: new Map() };
  for (const row of db.prepare(`SELECT r.trace_id FROM runs r WHERE ${predicate}`).iterate(params) as Iterable<{trace_id: string}>) {
    groups.runs.set(row.trace_id, { ...emptyCost(), missing_usage_runs: 1 });
  }
  const rows = db.prepare(`SELECT s.trace_id, s.model, s.attributes FROM spans s JOIN runs r ON r.trace_id=s.trace_id
    WHERE s.is_marker=0 AND s.span_kind='LLM' AND (${predicate})`).iterate(params) as Iterable<{trace_id: string; model: string | null; attributes: string}>;
  for (const row of rows) {
    let cost: CostEstimate;
    try { cost = priceCall(kvToPlain(JSON.parse(row.attributes) as KeyValue[]), prices); }
    catch { cost = { ...emptyCost(), unpriced_calls: 1 }; }
    const run = groups.runs.get(row.trace_id)!;
    run.missing_usage_runs = 0;
    for (const [map, key] of [[groups.runs, row.trace_id], [groups.models, row.model ?? "unknown"]] as const) {
      const sum = map.get(key) ?? emptyCost(); addCost(sum, cost); map.set(key, sum);
    }
  }
  for (const run of groups.runs.values()) addCost(groups.total, run);
  return groups;
}
export const runCost = (db: Database.Database, traceId: string, prices: Price[] = []) => readCosts(db, "r.trace_id=@traceId", { traceId }, prices).total;
