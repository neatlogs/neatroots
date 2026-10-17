import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { open } from "./util";

test.describe("checks", () => {
  test("lists rules and questions, and filters by group", async ({ page }) => {
    await open(page, "checks");
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await page.getByRole("tab", { name: /^Rules/ }).click();
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await page.getByRole("tab", { name: /^Library/ }).click();
    await expect(page.getByText("secret-in-output")).toHaveCount(0);
  });

  test("a check opens in a side sheet with its YAML", async ({ page }) => {
    await open(page, "checks");
    await page.getByText("secret-in-output").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("id: secret-in-output")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Edit a copy" })).toBeVisible();
  });

  test("turning a check off and on", async ({ page }) => {
    await open(page, "checks");
    const toggle = page.getByRole("switch", { name: /secret-in-output/ });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test("the new-check editor needs a description before drafting", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Draft check" })).toBeDisabled();
    await sheet.getByRole("textbox", { name: /Describe a problem/ }).fill("The agent refunds without checking the order");
    await expect(sheet.getByRole("button", { name: "Draft check" })).toBeEnabled();
  });

  test("preview separates evaluated, skipped and judge-error runs", async ({ page }, testInfo) => {
    const traceIds = {
      hit: "11111111111111111111111111111111",
      clear: "22222222222222222222222222222222",
      skipped: "33333333333333333333333333333333",
      error: "44444444444444444444444444444444",
    };
    await page.route("**/api/checks/preview", (route) => route.fulfill({
      json: {
        checked: 2,
        total: 4,
        hits: [{ trace_id: traceIds.hit, probability: 0.91, root_name: "hit-run" }],
        hit_rate: 0.5,
        skipped: { no_evidence: 1 },
        errors: { model_error: 1 },
        results: [
          { trace_id: traceIds.hit, root_name: "hit-run", status: "hit" },
          { trace_id: traceIds.clear, root_name: "clear-run", status: "clear", reason: "no_hit" },
          { trace_id: traceIds.skipped, root_name: "skipped-run", status: "skipped", reason: "no_evidence" },
          { trace_id: traceIds.error, root_name: "error-run", status: "error", reason: "model_error" },
        ],
        truncated: false,
        warnings: [],
      },
    }));
    await open(page, "checks");
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("textbox", { name: "Check (YAML)" }).fill("id: preview-example\nkind: yes_no\nscope: span\nask: Did the agent do something risky?\nflag_at: 0.8\n");
    await sheet.getByRole("button", { name: "Preview on recent runs" }).click();
    await expect(sheet.getByText("Fires on 1 of 2 evaluated runs · hit rate 50%")).toBeVisible();
    await expect(sheet.getByText("2 of 4 runs were not evaluated: 1 had no evidence, 1 had a judge error.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: /skipped-run: No evidence for this check/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /error-run: Judge error$/ })).toBeVisible();

    const screenshotDir = process.env.PREVIEW_VERDICTS_SCREENSHOT_DIR;
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      const suffix = `repeat-${testInfo.repeatEachIndex + 1}`;
      const html = page.locator("html");
      const surfaceColor = () => sheet.evaluate((element) => getComputedStyle(element).backgroundColor);
      const themeBackground = () => page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--background)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(html).not.toHaveClass(/\bdark\b/);
      await expect.poll(surfaceColor).toBe(await themeBackground());
      await page.screenshot({ path: path.join(screenshotDir, `preview-light-${suffix}.png`), fullPage: true });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(html).toHaveClass(/\bdark\b/);
      await expect.poll(surfaceColor).toBe(await themeBackground());
      await page.screenshot({ path: path.join(screenshotDir, `preview-dark-${suffix}.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(screenshotDir, `preview-390px-${suffix}.png`), fullPage: true });
    }
  });

  test("search narrows the table", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("textbox", { name: "Search checks" }).fill("secret");
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await expect(page.getByText("runaway-loop")).toHaveCount(0);
  });
});
