import { z } from "zod";

/** USD per million tokens, standard first-party text inference. No network lookup. */
export const PRICE_VERSION = "2026-10-18";
export const priceSchema = z.object({
  provider: z.string().trim().min(1), model: z.string().trim().min(1),
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative().optional(),
  cacheWrite: z.number().finite().nonnegative().optional(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  inputMode: z.enum(["includes-cache", "excludes-cache"]),
}).strict();
export type Price = z.infer<typeof priceSchema>;
export const overridesSchema = z.array(priceSchema).superRefine((rows, ctx) => {
  const keys = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const key = `${row.provider.toLowerCase()}/${row.model.toLowerCase()}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: [i], message: "duplicate provider/model price" });
    keys.add(key);
  }
});

export const PRICE_SOURCES = [
  "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://platform.claude.com/docs/en/models/sonnet-4-5/overview",
];
const bundled: Price[] = [
  { provider: "anthropic", model: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5, cacheWrite1h: 8, inputMode: "excludes-cache" },
  ...["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"].map((model): Price => ({ provider: "openai", model, input: 0.4, output: 1.6, cacheRead: 0.1, inputMode: "includes-cache" })),
  ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"].map((model): Price => ({ provider: "anthropic", model, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, inputMode: "excludes-cache" })),
];

export function matchPrice(provider: unknown, model: unknown, overrides: Price[] = []): Price | undefined {
  if (typeof provider !== "string" || typeof model !== "string") return;
  const p = provider.toLowerCase(), m = model.toLowerCase();
  const custom = overrides.find((r) => r.provider?.toLowerCase() === p && r.model?.toLowerCase() === m);
  // Defend callers that bypass configuration validation; never fall through a bad override.
  if (custom) { const parsed = priceSchema.safeParse(custom); return parsed.success ? parsed.data : undefined; }
  return bundled.find((r) => r.provider === p && r.model === m);
}

export interface CostEstimate {
  cost_usd: number | null;
  priced_calls: number;
  unpriced_calls: number;
  missing_usage_runs: number;
  fallback_calls: number;
  assumed_cache_ttl_calls: number;
}
export const emptyCost = (): CostEstimate => ({ cost_usd: null, priced_calls: 0, unpriced_calls: 0, missing_usage_runs: 0, fallback_calls: 0, assumed_cache_ttl_calls: 0 });
export function addCost(a: CostEstimate, b: CostEstimate): void {
  if (b.cost_usd !== null) a.cost_usd = (a.cost_usd ?? 0) + b.cost_usd;
  a.priced_calls += b.priced_calls; a.unpriced_calls += b.unpriced_calls;
  a.missing_usage_runs += b.missing_usage_runs;
  a.fallback_calls += b.fallback_calls; a.assumed_cache_ttl_calls += b.assumed_cache_ttl_calls;
  if (a.cost_usd !== null && !Number.isFinite(a.cost_usd)) { a.unpriced_calls += a.priced_calls; a.priced_calls = 0; a.cost_usd = null; }
}
const first = (a: Record<string, unknown>, keys: string[]) => {
  const key = keys.find((k) => Object.hasOwn(a, k));
  return key === undefined ? undefined : a[key];
};
const count = (v: unknown): number | undefined => {
  if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
};

/** Price raw, lossless attributes, never the cache-augmented token columns. */
export function priceCall(a: Record<string, unknown>, overrides: Price[] = []): CostEstimate {
  const result = emptyCost(); result.unpriced_calls = 1;
  const rate = matchPrice(first(a, ["neatlogs.llm.provider", "neatlogs.provider", "gen_ai.system", "gen_ai.provider.name", "llm.provider", "ai.model.provider"]),
    first(a, ["neatlogs.llm.model_name", "gen_ai.response.model", "gen_ai.request.model", "llm.model_name", "ai.response.model", "ai.model.id"]), overrides);
  if (!rate) return result;
  // Explicit nonstandard billing cannot be priced from the standard list table.
  const tier = first(a, ["gen_ai.request.service_tier", "openai.service_tier", "neatlogs.llm.service_tier"]);
  if (tier !== undefined && tier !== "default" && tier !== "standard") return result;
  const input = count(first(a, ["neatlogs.llm.token_count.prompt", "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "ai.usage.promptTokens", "ai.usage.inputTokens"]));
  const output = count(first(a, ["neatlogs.llm.token_count.completion", "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion", "ai.usage.completionTokens", "ai.usage.outputTokens"]));
  const readRaw = first(a, ["neatlogs.llm.token_count.cache_read", "gen_ai.usage.cache_read.input_tokens"]);
  const writeRaw = first(a, ["neatlogs.llm.token_count.cache_write", "gen_ai.usage.cache_creation.input_tokens"]);
  const read = readRaw === undefined ? 0 : count(readRaw), write = writeRaw === undefined ? 0 : count(writeRaw);
  if (input === undefined || output === undefined || read === undefined || write === undefined) return result;
  const uncached = rate.inputMode === "includes-cache" ? input - read - write : input;
  if (uncached < 0) return result;
  const custom = overrides.some((r) => r.provider.toLowerCase() === rate.provider.toLowerCase() && r.model.toLowerCase() === rate.model.toLowerCase());
  const legacySonnet = rate.provider === "anthropic" && ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"].includes(rate.model);
  if (!custom && legacySonnet && input + read + write > 200_000) return result;
  const ttl = a["neatlogs.llm.cache_ttl"];
  if (write && ttl !== undefined && ttl !== "5m" && ttl !== "1h") return result;
  const writeRate = ttl === "1h" ? rate.cacheWrite1h : rate.cacheWrite;
  const usd = (uncached * rate.input + output * rate.output + read * (rate.cacheRead ?? rate.input) + write * (writeRate ?? rate.input)) / 1_000_000;
  if (!Number.isFinite(usd) || usd < 0) return result;
  return { cost_usd: usd, priced_calls: 1, unpriced_calls: 0, missing_usage_runs: 0,
    fallback_calls: Number((read > 0 && rate.cacheRead === undefined) || (write > 0 && writeRate === undefined)),
    assumed_cache_ttl_calls: Number(write > 0 && ttl === undefined) };
}
