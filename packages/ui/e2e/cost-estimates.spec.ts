import { expect, test } from "@playwright/test";
import { open, state } from "./util";

const cases = [
  { name: "known", cost_usd: .01, priced_calls: 2, unpriced_calls: 0, fallback_calls: 0, assumed_cache_ttl_calls: 0, value: "$0.0100" },
  { name: "partial", cost_usd: .01, priced_calls: 1, unpriced_calls: 1, fallback_calls: 0, assumed_cache_ttl_calls: 0, value: "$0.0100 · partial" },
  { name: "unpriced", cost_usd: null, priced_calls: 0, unpriced_calls: 2, fallback_calls: 0, assumed_cache_ttl_calls: 0, value: "Unpriced" },
  { name: "missing usage", cost_usd: .01, priced_calls: 1, unpriced_calls: 0, missing_usage_runs: 1, fallback_calls: 0, assumed_cache_ttl_calls: 0, value: "$0.0100 · partial" },
  { name: "fallback", cost_usd: .02, priced_calls: 2, unpriced_calls: 0, fallback_calls: 1, assumed_cache_ttl_calls: 1, value: "$0.0200" },
];
for (const sample of cases) {
  test(`cost surfaces show ${sample.name} estimates`, async ({ page }, info) => {
    await page.route("**/api/insights?**", async (route) => {
      const response = await route.fetch(); const data = await response.json();
      await route.fulfill({ json: { ...data, totals: { ...data.totals, missing_usage_runs: 0, ...sample },
        models: [{ name: "priced-model", calls: 2, errors: 0, tokens: 1100, p50_ms: 10, missing_usage_runs: 0, ...sample }],
        projects: [{ name: "cost-project", runs: 1, failed: 0, with_problems: 0, prev_runs: 0, prev_with_problems: 0, last_ms: Date.now(), top_problem: null, tokens: 1100, missing_usage_runs: 0, ...sample }] } });
    });
    await page.route(`**/api/runs/${state().supportRun}`, async (route) => {
      const response = await route.fetch(); const data = await response.json();
      await route.fulfill({ json: { ...data, run: { ...data.run, cost: { missing_usage_runs: 0, ...sample } } } });
    });
    await open(page, "home");
    await expect(page.getByText("Estimated agent cost", { exact: true })).toBeVisible();
    await expect(page.getByText(sample.value, { exact: true }).first()).toBeVisible();
    const models = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Model", exact: true }) });
    const projects = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Project", exact: true }) });
    const modelBox = models.locator("xpath=../..");
    await expect(modelBox).toHaveCSS("height", "320px");
    await expect(models.getByRole("row").nth(1)).toHaveCSS("height", "44px");
    await expect(projects.getByRole("row").nth(1)).toHaveCSS("height", "44px");
    await expect(models).toContainText(sample.value); await expect(projects).toContainText(sample.value);
    await expect(models).toContainText(`${sample.unpriced_calls} calls unpriced`);
    if (sample.fallback_calls) { await expect(models).toContainText("cache fallback"); await expect(projects).toContainText("cache fallback"); }
    // Capture real rendered surfaces at both viewport sizes and both themes, once per suite.
    if (process.env.COST_SCREENSHOTS && sample.name === "partial" && info.repeatEachIndex === 0) {
      for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
        await page.screenshot({ path: `${process.env.COST_SCREENSHOTS}/home-${theme}-${width}.png`, fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await open(page, `runs/${state().supportRun}`);
    await expect(page.getByText("Estimated cost", { exact: true })).toBeVisible();
    await expect(page.getByText(sample.value, { exact: true })).toBeVisible();
    await expect(page.getByText("Unpriced calls", { exact: true })).toBeVisible();
    await expect(page.getByText(`${sample.unpriced_calls} of ${sample.priced_calls + sample.unpriced_calls}`, { exact: true })).toBeVisible();
    if (sample.name === "unpriced") await expect(page.getByText("$0.00", { exact: true })).toHaveCount(0);
    if (process.env.COST_SCREENSHOTS && sample.name === "partial" && info.repeatEachIndex === 0) {
      for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
        await page.screenshot({ path: `${process.env.COST_SCREENSHOTS}/run-${theme}-${width}.png`, fullPage: true });
      }
    }
  });
}

test("public OTLP usage reaches real run and Home cost surfaces", async ({ page, request }) => {
  const id = crypto.randomUUID().replaceAll("-", "");
  const now = BigInt(Date.now()) * 1_000_000n;
  const attrs = Object.entries({ "neatlogs.span.kind": "llm", "neatlogs.llm.provider": "openai", "neatlogs.llm.model_name": "gpt-4.1-mini", "neatlogs.llm.token_count.prompt": 1000000, "neatlogs.llm.token_count.completion": 100000 }).map(([key, value]) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } }));
  const response = await request.post(`${state().url}/v1/traces`, { data: { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "cost-live-test" } }] }, scopeSpans: [{ scope: { name: "cost-e2e" }, spans: [{ traceId: id, spanId: id.slice(0,16), name: "priced-call", kind: 1, startTimeUnixNano: String(now), endTimeUnixNano: String(now+1000000n), attributes: attrs, status: {code:1} }] }] }] } });
  expect(response.ok()).toBeTruthy();
  try {
    await open(page, `runs/${id}`);
    await expect(page.getByText("$0.5600", { exact: true })).toBeVisible();
    await expect(page.getByText("Unpriced calls", { exact: true })).toBeVisible();
    await expect(page.getByText("0 of 1", { exact: true })).toBeVisible();
    await open(page, "home");
    await expect(page.getByText("Estimated agent cost", { exact: true })).toBeVisible();
    const models = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Model", exact: true }) });
    const projects = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Project", exact: true }) });
    await expect(models.getByRole("row").filter({hasText:"gpt-4.1-mini"})).toContainText("$0.5600");
    await expect(projects.getByRole("row").filter({hasText:"cost-live-test"})).toContainText("$0.5600");
    await expect(page.getByText(/\$0\.5600 · partial/).first()).toBeVisible();
  } finally { await request.delete(`${state().url}/api/runs/${id}`); }
});
