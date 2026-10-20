import { expect, test } from "@playwright/test";
import { api, open, state, watchErrors } from "./util";

let comparisonRun: string;
test.beforeAll(async () => {
  comparisonRun = (await api<{ trace_id: string }>("/v1/trace", { method: "POST", body: JSON.stringify({
    name: "comparison research", project: "e2e-support", output: "Solar batteries store daytime energy for the night.",
    children: [{ name: "web_search", kind: "TOOL", tool_name: "web_search", input: "solar batteries", output: "facts" }],
  }) })).trace_id;
});

test("selects two runs, shows changes, swaps and survives reload", async ({ page }) => {
  const errors = watchErrors(page);
  const { supportRun } = state();
  const researchRun = comparisonRun;
  await open(page, `runs/${supportRun}`);
  await page.getByRole("button", { name: "Compare runs", exact: true }).click();
  await expect(page.getByText("Select two runs", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Comparison run", exact: true }).click();
  await page.getByRole("option").filter({ hasText: researchRun.slice(0, 8) }).click();
  await expect(page.getByTestId("metric-tokens")).toContainText("Not recorded");
  await expect(page.getByTestId("metric-tokens")).toContainText("Not available");
  await expect(page.getByTestId("metric-duration")).toContainText(" ms");
  await expect(page.getByRole("list", { name: "Original tool sequence" })).toContainText("lookup_order");
  await expect(page.getByRole("list", { name: "Comparison tool sequence" })).toContainText("web_search");
  await expect(page.getByTestId("output-0")).toContainText("payments key");
  await expect(page.getByTestId("output-1")).toContainText("Solar batteries");
  await expect(page.getByRole("list", { name: "No longer present" })).toContainText("Something that looks like a secret key");
  await expect(page.getByRole("list", { name: "New problems", exact: true })).toContainText("None");
  await page.getByRole("button", { name: "Swap runs" }).click();
  await expect(page).toHaveURL(new RegExp(`a=${researchRun}&b=${supportRun}`));
  await page.reload();
  await expect(page.getByTestId("metric-tokens")).toBeVisible();
  expect(errors).toEqual([]);
});

test("links a real replay back to its original and handles invalid selections", async ({ page }) => {
  const id = state().secondTurn;
  const detail = await api<{ spans: { span_id: string; span_kind: string }[] }>(`/api/runs/${id}`);
  const span = detail.spans.find((s) => s.span_kind === "LLM")!;
  const replay = await api<{ new_trace_id: string }>(`/api/runs/${id}/replay`, { method: "POST", body: JSON.stringify({ span_id: span.span_id }) });
  await open(page, `runs/${replay.new_trace_id}`);
  await page.getByRole("button", { name: "Compare runs", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`a=${id}&b=${replay.new_trace_id}`));
  await expect(page.getByText(/This replay contains one LLM call/)).toBeVisible();
  await open(page, `compare?a=${id}&b=${id}`);
  await expect(page.getByText("Choose a different run", { exact: true })).toBeVisible();
  await open(page, `compare?a=${id}&b=deleted-run`);
  await expect(page.getByText("Couldn't compare these runs", { exact: true })).toBeVisible();
});

test("labels stored root output previews", async ({ page }) => {
  const { supportRun } = state();
  const researchRun = comparisonRun;
  await page.route("**/api/compare?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.a.full_output = data.a.output;
    data.a.output_is_preview = true;
    await route.fulfill({ response, json: data });
  });
  await open(page, `compare?a=${supportRun}&b=${researchRun}`);
  await expect(page.getByText("Original output preview", { exact: true })).toBeVisible();
  await expect(page.getByText("Only the stored preview is available; the full root output was not recorded.", { exact: true })).toBeVisible();
});

test("keeps run-picker errors visible with paginated run searches", async ({ page }) => {
  await page.route("**/api/runs?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "fixture-unavailable") {
      await route.fulfill({ status: 503, json: { error: "fixture search unavailable" } });
    } else await route.continue();
  });
  await open(page, `compare?a=${state().supportRun}&b=${comparisonRun}`);
  await expect(page.getByTestId("metric-tokens")).toBeVisible();
  await page.getByRole("textbox", { name: "Search original runs", exact: true }).fill("fixture-unavailable");
  await expect(page.getByText("Couldn't load runs. Try searching again.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("metric-tokens")).toBeVisible();
});

for (const label of ["Original", "Comparison"] as const) {
  test(`${label} picker reaches older matching runs and retries page errors`, async ({ page }) => {
    const search = `picker-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ids: string[] = [];
    for (let i = 0; i < 155; i += 25) {
      const batch = await Promise.all(Array.from({ length: Math.min(25, 155 - i) }, (_, k) => api<{ trace_id: string }>("/v1/trace", {
        method: "POST",
        body: JSON.stringify({ name: search, project: "e2e-support", input: `${search} ${i + k}`, output: "done", start: new Date(Date.UTC(2020, 0, 1) + (i + k) * 1000).toISOString(), duration_ms: 5 }),
      })));
      ids.push(...batch.map((run) => run.trace_id));
    }
    const first = await api<{ runs: { trace_id: string }[] }>(`/api/runs?limit=150&q=${search}`);
    expect(first.runs).toHaveLength(150);
    expect(first.runs.map((run) => run.trace_id)).not.toContain(ids[0]);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let failPage = true;
    await page.route("**/api/runs?*", async (route) => {
      const q = new URL(route.request().url()).searchParams;
      if (q.get("q") === search && q.get("offset") === "150" && failPage) {
        await waiting;
        await route.fulfill({ status: 503, json: { error: "fixture page unavailable" } });
      } else await route.continue();
    });
    await open(page, `compare?a=${state().supportRun}&b=${comparisonRun}`);
    await page.getByRole("textbox", { name: `Search ${label.toLowerCase()} runs`, exact: true }).fill(search);
    const more = page.getByRole("button", { name: `Load more ${label.toLowerCase()} runs`, exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(more).toBeDisabled();
    await expect(more).toHaveAttribute("aria-busy", "true");
    release!();
    await expect(page.getByText("Couldn't load more runs. Try loading more again.", { exact: true })).toBeVisible();
    await expect(more).toBeEnabled();
    await expect(page.getByTestId("metric-tokens")).toBeVisible();
    failPage = false;
    await more.click();
    await expect(more).toBeHidden();
    await expect(page.getByText("Couldn't load more runs. Try loading more again.", { exact: true })).toBeHidden();
    await page.getByRole("combobox", { name: `${label} run`, exact: true }).click();
    await page.getByRole("option").filter({ hasText: ids[0].slice(0, 8) }).click();
    await expect(page).toHaveURL(new RegExp(`${label === "Original" ? "a" : "b"}=${ids[0]}`));
    await expect(page.getByTestId("metric-tokens")).toBeVisible();
  });
}

for (const mode of ["light", "dark", "mobile"] as const) {
  test(`comparison layout in ${mode}`, async ({ page }, info) => {
    const errors = watchErrors(page);
    await page.addInitScript((theme) => localStorage.setItem("neatroots-theme", theme), mode === "dark" ? "dark" : "light");
    if (mode === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${state().url}/#/compare?a=${state().supportRun}&b=${comparisonRun}`);
    await expect(page.getByTestId("metric-tokens")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`compare-${mode}.png`), fullPage: true });
    await page.getByTestId("output-0").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`compare-${mode}-outputs.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("opens comparison from a run on mobile without overflowing the toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${state().url}/#/runs/${state().supportRun}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Compare runs", exact: true }).click();
  await expect(page.getByText("Select two runs", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const outcome of ["finished", "missing"] as const) {
  test(`stops polling when a live comparison becomes ${outcome}`, async ({ page }) => {
    let requests = 0;
    await page.route("**/api/compare?*", async (route) => {
      requests++;
      if (requests > 1 && outcome === "missing") {
        await route.fulfill({ status: 404, json: { error: "run not found" } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      body.a.summary.status = requests === 1 ? "running" : "ok";
      body.b.summary.status = "ok";
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${state().url}/#/compare?a=${state().supportRun}&b=${state().secondTurn}`);
    await expect(page.getByTestId("metric-tokens")).toBeVisible();
    await expect.poll(() => requests, { timeout: 8000 }).toBe(2);
    if (outcome === "missing") await expect(page.getByText("Couldn't compare these runs", { exact: true })).toBeVisible();
    else await expect(page.getByText("Running", { exact: true })).toHaveCount(0);
    // Observe longer than the refresh interval to catch an unwanted third request.
    await page.waitForTimeout(3500);
    expect(requests).toBe(2);
  });
}

test("explains cross-project comparison and missing original or deleted other run", async ({ page }) => {
  await open(page, `compare?a=${state().supportRun}&b=${state().researchRun}`);
  await expect(page.getByText("Choose two runs from the same project to compare in the app.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("metric-tokens")).toHaveCount(0);
  await open(page, `compare?a=unknown-original&b=${comparisonRun}`);
  await expect(page.getByText("Original run not found. It may have been deleted or removed by retention.", { exact: true })).toBeVisible();
  const removed = await api<{ trace_id: string }>("/v1/trace", { method: "POST", body: JSON.stringify({ name: "removed", project: "e2e-support", output: "done" }) });
  await api(`/api/runs/${removed.trace_id}`, { method: "DELETE" });
  await open(page, `compare?a=${state().supportRun}&b=${removed.trace_id}`);
  await expect(page.getByText("Comparison run not found. It may have been deleted or removed by retention.", { exact: true })).toBeVisible();
});

for (const mode of ["light", "dark", "mobile"] as const) {
  test(`replay banner opens its preselected pair in ${mode}`, async ({ page }, info) => {
    const id = state().secondTurn;
    const detail = await api<{ spans: { span_id: string; span_kind: string }[] }>(`/api/runs/${id}`);
    const replay = await api<{ new_trace_id: string }>(`/api/runs/${id}/replay`, { method: "POST", body: JSON.stringify({ span_id: detail.spans.find((s) => s.span_kind === "LLM")!.span_id }) });
    await page.addInitScript((theme) => localStorage.setItem("neatroots-theme", theme), mode === "dark" ? "dark" : "light");
    if (mode === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${state().url}/#/runs/${replay.new_trace_id}`);
    await expect(page.getByRole("link", { name: `run ${id.slice(0, 8)}`, exact: true })).toHaveAttribute("href", `#/runs/${id}`);
    const link = page.getByRole("link", { name: "Compare with original", exact: true });
    await expect(link).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`replay-banner-${mode}.png`), fullPage: true });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`a=${id}&b=${replay.new_trace_id}`));
    await expect(page.getByTestId("metric-tokens")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Original run", exact: true })).toContainText(id.slice(0, 8));
    await expect(page.getByRole("combobox", { name: "Comparison run", exact: true })).toContainText(replay.new_trace_id.slice(0, 8));
  });
}
