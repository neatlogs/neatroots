import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { buildView } from "../src/semantics/view.js";
import type { OtlpSpan } from "../src/otlp/types.js";
import { batch, hex, llmSpan, s, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const budget = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "token-budget") as RuleCheck;

// What the Neatlogs SDK sends for one call: total is input + output, cached tokens apart.
function withUsage(sp: OtlpSpan, provider: string, u: { prompt: number; completion: number; cacheRead: number; cacheWrite: number }): OtlpSpan {
  const values: Record<string, number> = {
    "neatlogs.llm.token_count.prompt": u.prompt,
    "neatlogs.llm.token_count.completion": u.completion,
    "neatlogs.llm.token_count.total": u.prompt + u.completion,
  };
  sp.attributes = sp.attributes.filter((a) => !(a.key in values));
  for (const [k, v] of Object.entries(values)) sp.attributes.push(s(k, v));
  sp.attributes.push(s("neatlogs.llm.provider", provider), s("neatlogs.llm.token_count.cache_read", u.cacheRead), s("neatlogs.llm.token_count.cache_write", u.cacheWrite));
  return sp;
}

describe("prompt-cache tokens", () => {
  it("counts Anthropic cache reads and writes as input", () => {
    const sp = withUsage(llmSpan(hex(16), hex(8), { user: "hi", out: "ok" }), "anthropic", { prompt: 62, completion: 16_565, cacheRead: 1_057_791, cacheWrite: 66_786 });
    const v = buildView(sp, []);
    expect(v.promptTokens).toBe(62 + 1_057_791 + 66_786);
    expect(v.totalTokens).toBe(62 + 16_565 + 1_057_791 + 66_786);
  });

  it("leaves OpenAI counts alone, since its prompt count already includes cached tokens", () => {
    const sp = withUsage(llmSpan(hex(16), hex(8), { user: "hi", out: "ok" }), "openai", { prompt: 5_000, completion: 100, cacheRead: 4_096, cacheWrite: 0 });
    const v = buildView(sp, []);
    expect(v.promptTokens).toBe(5_000);
    expect(v.totalTokens).toBe(5_100);
  });

  it("doesn't count cache twice when the provider's total already includes it", () => {
    const sp = withUsage(llmSpan(hex(16), hex(8), { user: "hi", out: "ok" }), "bedrock", { prompt: 10, completion: 5, cacheRead: 1_000, cacheWrite: 0 });
    sp.attributes = sp.attributes.filter((a) => a.key !== "neatlogs.llm.token_count.total");
    sp.attributes.push(s("neatlogs.llm.token_count.total", 1_015));
    expect(buildView(sp, []).totalTokens).toBe(1_015);
  });

  it("fires token-budget for a cache-heavy Anthropic run", () => {
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    const root = hex(8);
    st.ingest([batch([withUsage(llmSpan(t, root, { user: "hi", out: "ok" }), "anthropic", { prompt: 62, completion: 16_565, cacheRead: 1_057_791, cacheWrite: 66_786 })])]);
    const hit = evaluateRule(budget, loadTrace(st, t)!, false);
    st.close?.();
    expect(hit).toBeTruthy();
  });
});
