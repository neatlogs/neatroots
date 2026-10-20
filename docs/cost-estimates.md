# Local agent cost estimates

The run Tokens rail, Home KPI, Models table and Projects table show USD estimates for agent LLM spans. Prices are computed at read time from stored raw attributes, without migrations, token-column changes or requests to pricing services. Changing a local price applies to previously received spans on the next read. Existing LLM classification excludes Vercel wrapper spans; estimates use that same classification.

## Bundled rates

Table version: **2026-10-18**. USD per million text tokens, standard first-party API rates checked on that date:

| Provider | Exact model IDs | Input | Output | Cache read | Cache write |
|---|---|---:|---:|---:|---:|
| openai | gpt-4.1-mini, gpt-4.1-mini-2025-04-14 | 0.40 | 1.60 | 0.10 | input fallback |
| anthropic | claude-opus-5-5 | 4 | 20 | 0.20 | 5 (5m), 8 (1h) |
| anthropic | claude-sonnet-4-5, claude-sonnet-4-5-20250929 | 3 | 15 | 0.30 | 3.75 (5m), 6 (1h) |

Sources: [OpenAI model price and snapshot](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Anthropic snapshot ID](https://platform.claude.com/docs/en/models/sonnet-4-5/overview), [Anthropic standard prices and cache durations](https://platform.claude.com/docs/en/about-claude/pricing).

Only explicit provider and exact model IDs match (case-insensitive). Unlisted snapshots, arbitrary suffixes, missing providers, regional/Bedrock/Azure IDs and local models remain unpriced unless configured. There is no universal regional, batch, priority, long-context or negotiated price. Explicit nonstandard service tiers are unpriced; bundled Sonnet 4.5 input above 200k tokens is unpriced. The bundled Opus 5.5 entry uses its standard full-context rates instead of that legacy guard. This is standard text-token estimation, not billing reconciliation: tool/search charges, images, audio, storage, taxes and discounts are excluded. If telemetry omits a billing modifier the estimate cannot account for it. Use an exact local override for your applicable rate.

Input/output counts must both be present, nonnegative safe integers. Missing or invalid usage is unpriced, not zero. Known zero usage can cost zero. Totals show the priced subtotal and unpriced call count; a mixed total is labeled partial. A run with no priced calls shows Unpriced. Runs lacking any LLM usage are counted separately as missing usage; they make a mixed project/period subtotal partial without inventing an LLM call count.

Anthropic and Bedrock input excludes cache reads/writes; OpenAI prompt input includes them. Calculation uses raw attributes rather than derived token columns. Missing cache counters mean no reported cache usage. Cache rates missing from an override fall back to input and are visibly flagged. Cache writes without duration use a **5-minute estimate assumption**, counted separately. Optional `neatlogs.llm.cache_ttl` values `5m` and `1h` select the duration; an unknown explicit duration is unpriced. The telemetry often lacks TTL, so the result is always an estimate. A missing 1h rate also falls back to input and is flagged.

The original cache-heavy Opus 5.5 example (62 input, 16,565 output, 1,057,791 cache-read and 66,786 cache-write tokens) estimates **$0.8770362** at the standard rates with the flagged 5-minute write assumption. An explicitly reported 1-hour write estimates **$1.0773942**. These are token estimates, not billing reconciliation or a guarantee that every request used standard service pricing.

## Local overrides

Edit `~/.neatroots/config.yaml` and restart neatroots. No UI or external fetch is needed:

```yaml
pricing:
  overrides:
    - provider: bedrock
      model: your-exact-model-id
      inputMode: excludes-cache
      input: 3
      output: 15
      cacheRead: 0.3
      cacheWrite: 3.75
      cacheWrite1h: 6
```

Rates are USD per million tokens; finite nonnegative numeric rates only (fractional prices are valid). `inputMode` is required: `includes-cache` subtracts cached tokens before normal input pricing, `excludes-cache` adds them separately. Exact provider/model overrides take precedence. Duplicate keys and malformed rates are rejected when loading/saving config; invalid values passed directly to pricing cannot create negative/NaN/free estimates. No assumption is made about provider aliases. Configure the provider exactly as reported by your instrumentation. Cache-rate work is independent of PR368: stored token semantics are unchanged.

Only the selected current window is priced by the insights API. Its `previous` comparison contains run, problem, token and duration metrics, with no cost fields; historical runs are priced when included in the selected window or read individually.
