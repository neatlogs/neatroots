import { describe, expect, it } from "vitest";
import { priceCall, matchPrice, overridesSchema, type Price } from "../src/models/pricing.js";
const usage = (provider = "openai", model = "gpt-4.1-mini", input: unknown = 1000, output: unknown = 100) => ({
  "neatlogs.llm.provider": provider, "neatlogs.llm.model_name": model,
  "neatlogs.llm.token_count.prompt": input, "neatlogs.llm.token_count.completion": output,
});
const custom: Price = { provider: "bedrock", model: "custom", input: 3, output: 15, inputMode: "excludes-cache" };
describe("local token prices", () => {
  it("matches exact published aliases and dated snapshots, never arbitrary prefixes/providers", () => {
    expect(matchPrice("openai", "gpt-4.1-mini-2025-04-14")).toBeTruthy();
    for (const model of ["gpt-4.1-mini-turbo", "gpt-4.1-mini-2099-01-01", "azure/gpt-4.1-mini"]) expect(matchPrice("openai", model)).toBeUndefined();
    expect(matchPrice("anthropic", "claude-sonnet-4-5-20250929")).toBeTruthy();
    expect(matchPrice("anthropic", "claude-sonnet-4-5-20990101")).toBeUndefined();
    expect(matchPrice("bedrock", "claude-sonnet-4-5")).toBeUndefined();
    expect(matchPrice(undefined, "gpt-4.1-mini")).toBeUndefined();
  });
  it("prices OpenAI reads inside prompt counts exactly once", () => {
    const c = priceCall({ ...usage(), "neatlogs.llm.token_count.cache_read": 800 });
    expect(c.cost_usd).toBeCloseTo((200 * .4 + 800 * .1 + 100 * 1.6) / 1e6);
  });
  it("prices Anthropic cache outside input and flags the missing TTL assumption", () => {
    const a = { ...usage("anthropic", "claude-sonnet-4-5", 62, 16565), "neatlogs.llm.token_count.cache_read": 105779, "neatlogs.llm.token_count.cache_write": 6678 };
    expect(priceCall(a)).toMatchObject({ assumed_cache_ttl_calls: 1, fallback_calls: 0 });
    expect(priceCall(a).cost_usd).toBeCloseTo((62*3+16565*15+105779*.3+6678*3.75)/1e6);
    expect(priceCall({ ...a, "neatlogs.llm.cache_ttl": "1h" }).cost_usd).toBeCloseTo((62*3+16565*15+105779*.3+6678*6)/1e6);
  });
  it("prices the original Opus 5.5 cache-heavy example at standard rates", () => {
    const a = { ...usage("anthropic", "claude-opus-5-5", 62, 16565), "neatlogs.llm.token_count.cache_read": 1057791, "neatlogs.llm.token_count.cache_write": 66786 };
    expect(priceCall(a)).toMatchObject({ priced_calls: 1, unpriced_calls: 0, fallback_calls: 0, assumed_cache_ttl_calls: 1 });
    expect(priceCall(a).cost_usd).toBeCloseTo(0.8770362, 12);
    expect(priceCall({ ...a, "neatlogs.llm.cache_ttl": "5m" })).toMatchObject({ assumed_cache_ttl_calls: 0, fallback_calls: 0 });
    expect(priceCall({ ...a, "neatlogs.llm.cache_ttl": "5m" }).cost_usd).toBeCloseTo(0.8770362, 12);
    expect(priceCall({ ...a, "neatlogs.llm.cache_ttl": "1h" }).cost_usd).toBeCloseTo(1.0773942, 12);
    for (const model of ["claude-opus-5-5-future", "claude-opus-5-5-20990101"]) expect(priceCall({ ...a, "neatlogs.llm.model_name": model }).cost_usd).toBeNull();
    expect(priceCall({ ...a, "neatlogs.llm.provider": "bedrock" }).cost_usd).toBeNull();
    expect(priceCall({ ...a, "neatlogs.llm.provider": "unknown" }).cost_usd).toBeNull();
    expect(priceCall({ ...a, "gen_ai.request.service_tier": "priority" }).cost_usd).toBeNull();
    expect(priceCall({ ...a, "neatlogs.llm.model_name": "claude-sonnet-4-5" }).cost_usd).toBeNull();
    expect(priceCall({ ...a, "neatlogs.llm.model_name": "claude-sonnet-4-5-20250929" }).cost_usd).toBeNull();
  });
  it("flags explicit override cache fallback and respects provider cache semantics", () => {
    const c = priceCall({ ...usage("bedrock", "custom"), "neatlogs.llm.token_count.cache_read": 200 }, [custom]);
    expect(c).toMatchObject({ fallback_calls: 1, cost_usd: .0051 });
  });
  it("prices the reported large cache fixture only with explicit applicable local rates", () => {
    const a = { ...usage("bedrock", "custom", 62, 16565), "neatlogs.llm.token_count.cache_read": 1057791, "neatlogs.llm.token_count.cache_write": 66786 };
    const rates = { ...custom, cacheRead: .3, cacheWrite: 3.75 };
    expect(priceCall(a, [rates]).cost_usd).toBeCloseTo((62*3+16565*15+1057791*.3+66786*3.75)/1e6);
  });
  it("does not equate absent/invalid usage to free usage", () => {
    for (const x of [undefined, null, -1, Infinity, NaN, 1.2, "", "-1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(priceCall({ ...usage(), "neatlogs.llm.token_count.prompt": x }).cost_usd).toBeNull();
    }
    expect(priceCall(usage("openai", "gpt-4.1-mini", 0, 0)).cost_usd).toBe(0);
    expect(priceCall(usage("local", "custom", 0, 0)).cost_usd).toBeNull();
    expect(priceCall({ ...usage(), "neatlogs.llm.token_count.cache_read": 2000 }).cost_usd).toBeNull();
    expect(priceCall({ ...usage(), "neatlogs.llm.token_count.cache_write": -1 }).cost_usd).toBeNull();
  });
  it("does not guess nonstandard tier or long-context prices", () => {
    expect(priceCall({ ...usage(), "gen_ai.request.service_tier": "priority" }).cost_usd).toBeNull();
    expect(priceCall(usage("anthropic", "claude-sonnet-4-5", 200001)).cost_usd).toBeNull();
  });
  it("applies custom long-context rates identically regardless of configured casing", () => {
    const row: Price = { provider: "anthropic", model: "claude-sonnet-4-5", input: 6, output: 22.5, inputMode: "excludes-cache" };
    const a = usage("anthropic", "claude-sonnet-4-5", 250000, 100);
    expect(priceCall(a, [row])).toEqual(priceCall(a, [{...row, provider: "ANTHROPIC", model: "CLAUDE-SONNET-4-5"}]));
    expect(priceCall(a, [row]).cost_usd).toBeCloseTo(1.50225);
  });
  it("rejects malformed and duplicate overrides and defends direct callers", () => {
    for (const input of [-1, Infinity, NaN, "3"]) expect(overridesSchema.safeParse([{ ...custom, input }]).success).toBe(false);
    expect(overridesSchema.safeParse([custom, custom]).success).toBe(false);
    expect(priceCall(usage("bedrock", "custom"), [{ ...custom, input: -1 }]).cost_usd).toBeNull();
  });
});
