import type { CostEstimate } from "./api";

export function costValue(c?: CostEstimate): string {
  if (!c || typeof c.cost_usd !== "number" || !Number.isFinite(c.cost_usd) || c.cost_usd < 0) return "Unpriced";
  const usd = c.cost_usd === 0 ? "$0.00" : c.cost_usd < 0.0001 ? "<$0.0001" : `$${c.cost_usd.toFixed(4)}`;
  return `${usd}${(c.unpriced_calls || c.missing_usage_runs) ? " · partial" : ""}`;
}
export function costDetail(c?: CostEstimate): string {
  if (!c) return "Agent token estimate unavailable";
  return [`${c.unpriced_calls} of ${c.priced_calls + c.unpriced_calls} calls unpriced`,
    c.missing_usage_runs ? `${c.missing_usage_runs} runs missing LLM usage` : "",
    c.fallback_calls ? `${c.fallback_calls} cache-rate fallback` : "",
    c.assumed_cache_ttl_calls ? `${c.assumed_cache_ttl_calls} assumed 5m cache TTL` : "",
    "Standard token estimate; excludes judging calls and other fees"].filter(Boolean).join(" · ");
}
