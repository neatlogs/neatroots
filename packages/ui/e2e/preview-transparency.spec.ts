import { expect, test } from "@playwright/test";
import { state } from "./util";

for (const mode of ["light", "dark", "mobile-light", "mobile-dark"] as const) {
  test.describe(mode, () => {
  test.use({ hasTouch: mode.startsWith("mobile") });
  test(`preview explains bounded filtering and partial verdicts in ${mode}`, async ({ page }, info) => {
    await page.addInitScript((theme) => localStorage.setItem("neatroots-theme", theme), mode.endsWith("dark") ? "dark" : "light");
    if (mode.startsWith("mobile")) await page.setViewportSize({ width: 390, height: 844 });
    const longName = "capped negative " + "long recorded run name ".repeat(16);
    await page.route("**/api/checks/preview", (route) => route.fulfill({ json: {
      checked: 2, total: 4, hit_rate: 0.5, hits: [{ trace_id: "hit", root_name: "early hit", probability: 0.95 }],
      second_look: false, evaluation_mode: "question_without_second_look", truncated: false,
      selection: { candidate_limit: 500, candidate_count: 7, selected_count: 4, window_full: false },
      skipped: { no_evidence: 1 }, errors: { model_error: 1 },
      results: [
        { trace_id: "hit", root_name: "early hit", status: "hit", evaluation: { targets_available: 3, targets_considered: 3, targets_attempted: 1, targets_evaluated: 1, target_limit: 5, complete: false, stop_reason: "hit" } },
        { trace_id: "cap", root_name: longName, status: "clear", reason: "no_hit", evaluation: { targets_available: 8, targets_considered: 5, targets_attempted: 5, targets_evaluated: 5, target_limit: 5, complete: false, stop_reason: "target_limit" } },
        { trace_id: "none", root_name: "no evidence", status: "skipped", reason: "no_evidence" },
        { trace_id: "error", root_name: "judge failed", status: "error", reason: "model_error" },
      ],
      filtered_results: [
        { trace_id: "running", root_name: "unfinished", status: "filtered", reason: "running" },
        { trace_id: "scope", root_name: "other workflow", status: "filtered", reason: "applies_to" },
        { trace_id: "limit", root_name: "older eligible", status: "filtered", reason: "limit" },
      ],
    } }));
    await page.goto(`${state().url}/#/checks`);
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("textbox", { name: "Check (YAML)" }).fill("id: transparency\nkind: yes_no\nscope: span\nask: Did the agent fail?\nflag_at: 0.8");
    await sheet.getByRole("button", { name: "Preview on recent runs" }).click();
    await expect(sheet.getByText("Question preview skips the live second look. A preview hit may not become a live finding.")).toBeVisible();
    await expect(sheet.getByText(/Selected 4 of 7 candidates from a window of at most 500/)).toBeVisible();
    const results = sheet.getByLabel("Preview run results");
    await expect(results.getByRole("button", { name: /early hit: Fired; partial: 1\/3 targets judged/ })).toBeVisible();
    for (const text of ["no evidence: No evidence", "judge failed: Judge error", "unfinished: Filtered: run still running", "other workflow: Filtered: outside check scope", "older eligible: Filtered: selected-run limit"]) {
      const row = results.getByRole("button", { name: new RegExp(text) });
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();
    }
    const partial = results.getByRole("button", { name: /capped negative .*Evaluated; no hit; partial/ });
    await partial.scrollIntoViewIfNeeded();
    const name = partial.getByText(longName, { exact: true });
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await results.getByRole("button").evaluateAll((rows) => new Set(rows.map((row) => row.getBoundingClientRect().height)).size)).toBe(1);
    const listHeight = await results.evaluate((element) => element.getBoundingClientRect().height);
    if (mode.startsWith("mobile")) await partial.tap();
    else await partial.click();
    expect(await results.evaluate((element) => element.getBoundingClientRect().height)).toBe(listHeight);
    const detail = sheet.getByRole("region", { name: "Preview result detail" });
    const fullReason = "Evaluated; no hit; partial: 5/8 targets judged (Only the latest five matching targets were considered)";
    const text = detail.getByText(fullReason, { exact: true });
    await text.scrollIntoViewIfNeeded();
    await expect(text).toBeVisible();
    expect(await text.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("none");
    expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(detail.getByRole("link", { name: "Open run" })).toHaveAttribute("href", "#/runs/cap");
    expect(await results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`preview-${mode}.png`), fullPage: true });
  });
  });
}
