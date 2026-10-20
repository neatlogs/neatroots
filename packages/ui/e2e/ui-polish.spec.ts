import fs from "node:fs";
import path from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";
import { state } from "./util";

const captureDir = process.env.UI_POLISH_CAPTURE_DIR;
const capturePrefix = process.env.UI_POLISH_CAPTURE_PREFIX ?? "base";
if (captureDir) fs.mkdirSync(captureDir, { recursive: true });
function capturePath(testInfo: TestInfo, filename: string): string {
  return captureDir ? path.join(captureDir, filename) : testInfo.outputPath(filename);
}
const themes = ["light", "dark"] as const;
const widths = [780, 390] as const;

async function openWithTheme(page: import("@playwright/test").Page, route: string, theme: "light" | "dark", width: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.goto(state().url);
  await page.evaluate((value) => localStorage.setItem("neatroots-theme", value), theme);
  await page.reload();
  await page.goto(state().url + "/#/" + route.replace(/^[#/]+/, ""));
  await expect(page.getByRole("main").first()).toBeVisible();
}

async function mockOutOfOrderSetup(page: import("@playwright/test").Page) {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.stats) body.stats.runs = Math.max(body.stats.runs ?? 0, 1);
    if (body.engine?.llm) body.engine.llm.ok = false;
    if (body.classifier?.laya) body.classifier.laya.state = "stopped";
    if (body.mcp) body.mcp.last_seen_ms = null;
    if (body.cloud) body.cloud.has_key = false;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/projects", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const project = body.projects?.[0] ?? { project: "fixture", settings: { steering: "off", forward: false } };
    body.projects = [{
      ...project,
      settings: { ...project.settings, steering: "advisory" },
      project: "refund-agent-with-a-deliberately-long-project-name-for-testing-bounded-setup-state-copy",
    }];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/agents", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.agents = (body.agents ?? []).map((agent: { connected: boolean }) => ({ ...agent, connected: false }));
    await route.fulfill({ response, json: body });
  });
}

async function mockFindingError(page: import("@playwright/test").Page) {
  await page.route("**/api/runs/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== "/api/runs/" + state().loopRun) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.findings && body.findings.length) {
      const finding = body.findings[0];
      const ids = finding.evidence_span_ids ?? [];
      const cause = "The order lookup failed after the agent sent a customer reference that could not be found in the inventory index. This synthetic explanation is deliberately long enough to test the bounded expanded detail at mobile and tablet widths. ".repeat(4);
      finding.title = "Refund order 4512 could not be completed after the inventory lookup returned an error for the supplied customer reference";
      finding.explanation = {
        ...(finding.explanation ?? {}),
        cause,
        fix: "Check the customer reference format, then retry against the current inventory service. ".repeat(8),
        evidence_span_ids: ids,
      };
      finding.detail = {
        ...finding.detail,
        params: {
          tool: "lookup_order_by_customer_reference_and_region_with_a_name_longer_than_a_typical_tool_label",
          error: Array.from({ length: 18 }, (_, index) => `HTTP 504 gateway timeout while fetching order details from inventory shard north-east-04, attempt ${index + 1}; the upstream request exceeded its service deadline.`).join("\n"),
        },
      };
      const longTools = [
        "lookup_order_by_customer_reference_and_region_with_a_long_label",
        "retrieve_order_details_from_inventory_service_for_customer",
        "validate_transaction_against_current_customer_refund_policy",
      ];
      for (const [index, span] of (body.spans ?? []).filter((candidate: { span_id: string }) => ids.includes(candidate.span_id)).entries()) {
        span.tool_name = longTools[index % longTools.length];
      }
    }
    await route.fulfill({ response, json: body });
  });
}

test("Home setup clarity and bounded long copy at the reported breakpoints", async ({ page }, testInfo) => {
  await mockOutOfOrderSetup(page);
  for (const width of widths) {
    for (const theme of themes) {
      await openWithTheme(page, "home", theme, width);
      const heading = page.getByRole("heading", { name: "How to use neatroots" });
      await expect(heading).toBeVisible();
      const setup = page.locator('[data-slot="panel"]').filter({ has: heading });
      const show = page.getByRole("button", { name: "Show setup steps" });
      if (await show.isVisible()) await show.click();
      const counter = await setup.getByText("3 of 6 set up", { exact: true }).count();
      expect.soft(counter, width + "px " + theme + ": out-of-order setup count").toBe(1);
      const doneCount = await setup.getByText("Done", { exact: true }).count();
      expect.soft(doneCount, width + "px " + theme + ": completed steps explicitly say Done").toBe(3);
      const nextCount = await setup.getByText("Next", { exact: true }).count();
      expect.soft(nextCount, width + "px " + theme + ": pending step explicitly says Next").toBe(1);
      const secondStep = setup.locator("ol").first().locator("li").nth(1).locator("button").first();
      expect.soft(await secondStep.getAttribute("aria-expanded"), width + "px " + theme + ": step two is next").toBe("true");
      const rows = setup.locator("ol").first().locator("li");
      const rowHeights = await rows.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
      expect.soft(rowHeights, width + "px " + theme + ": setup summary rows have one fixed height").toEqual(Array(6).fill(56));
      const runsStep = rows.nth(0).locator(":scope > button");
      await expect(runsStep).toHaveAttribute("aria-label", /refund-agent-with-a-deliberately-long-project-name/);
      await runsStep.click();
      const setupDetail = setup.getByTestId("setup-step-detail");
      await expect(setupDetail.getByTestId("setup-step-full-state")).toContainText("refund-agent-with-a-deliberately-long-project-name-for-testing-bounded-setup-state-copy");
      const setupDetailMetrics = await setupDetail.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      expect.soft(setupDetailMetrics.scrollWidth, width + "px " + theme + ": long setup state stays within the detail width").toBeLessThanOrEqual(setupDetailMetrics.width + 1);
      expect.soft(setupDetailMetrics.overflowY, width + "px " + theme + ": setup detail scrolls inside its fixed box").toBe("auto");
      expect.soft(setupDetailMetrics.height, width + "px " + theme + ": setup detail remains bounded").toBe(160);
      expect.soft(setupDetailMetrics.scrollHeight, width + "px " + theme + ": long setup copy is available in its detail").toBeGreaterThan(setupDetailMetrics.clientHeight);
      const dark = await page.locator("html").evaluate((node) => node.classList.contains("dark"));
      expect.soft(dark, width + "px theme application").toBe(theme === "dark");
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-home-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
      await setupDetail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-home-detail-bottom-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
    }
  }
});

test("Run summaries stay fixed while long finding copy, badges and errors remain available", async ({ page }, testInfo) => {
  await mockFindingError(page);
  for (const width of widths) {
    for (const theme of themes) {
      await openWithTheme(page, "runs/" + state().loopRun, theme, width);
      await expect(page.getByRole("heading", { name: "Refund order 4512" })).toBeVisible();
      const problems = page.getByTestId("problems");
      await expect(problems).toBeVisible();
      const expanded = problems.locator('button[aria-expanded="true"]').first();
      await expect(expanded).toBeVisible();
      const problemRows = problems.locator("ul > li > button");
      const rowHeights = await problemRows.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
      expect.soft(rowHeights.every((height) => height === 56), width + "px " + theme + ": finding summary rows share a fixed height").toBe(true);
      await expect(expanded).toHaveAttribute("aria-label", /Refund order 4512 could not be completed after the inventory lookup/);
      const detail = problems.getByTestId("problem-detail");
      await expect(detail.getByTestId("finding-full-title")).toContainText("could not be completed");
      await expect(detail.getByTestId("finding-full-preview")).toContainText("synthetic explanation is deliberately long");
      const detailMetrics = await detail.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      expect.soft(detailMetrics.scrollWidth, width + "px " + theme + ": expanded finding detail has no horizontal overflow").toBeLessThanOrEqual(detailMetrics.width + 1);
      expect.soft(detailMetrics.overflowY, width + "px " + theme + ": expanded finding details scroll inside their fixed box").toBe("auto");
      expect.soft(detailMetrics.height, width + "px " + theme + ": detail height is bounded at the responsive size").toBe(width === 390 ? 192 : 224);
      expect.soft(detailMetrics.scrollHeight, width + "px " + theme + ": realistic long finding content scrolls internally").toBeGreaterThan(detailMetrics.clientHeight);
      const chips = await problems.locator('button[title^="Open span "]').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
      const chipLines = new Set(chips.map((top) => Math.round(top)));
      expect.soft(chipLines.size, width + "px: long evidence labels wrap naturally into bounded lines").toBeGreaterThan(0);
      const chipMetrics = await problems.getByTestId("evidence-chip-list").locator(":scope > div").evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        gap: getComputedStyle(element).columnGap,
        buttons: Array.from(element.querySelectorAll("button")).map((button) => ({
          width: button.clientWidth,
          scrollWidth: button.scrollWidth,
          paddingLeft: getComputedStyle(button).paddingLeft,
        })),
      }));
      expect.soft(chipMetrics.scrollWidth, width + "px: badge group has bounded width").toBeLessThanOrEqual(chipMetrics.width + 1);
      expect.soft(chipMetrics.gap, width + "px: evidence badges keep readable spacing").toBe("6px");
      expect.soft(chipMetrics.buttons.every((button) => button.scrollWidth <= button.width + 1), width + "px: long badge labels wrap within the chip").toBe(true);
      expect.soft(chipMetrics.buttons.every((button) => Number.parseFloat(button.paddingLeft) >= 8), width + "px: chips retain shared design-system padding").toBe(true);
      const errorTextCount = await problems.getByTestId("finding-error-copy").filter({ hasText: "HTTP 504 gateway timeout" }).count();
      expect.soft(errorTextCount, width + "px: fixture exposes the long error text").toBe(1);
      expect.soft(await problems.getByTestId("finding-error").count(), width + "px: tool error uses a distinct block").toBe(1);
      const error = problems.getByTestId("finding-error");
      const errorClasses = await error.getAttribute("class");
      expect.soft(errorClasses, width + "px: tool error uses danger styling").toMatch(/bg-danger-surface/);
      const errorCopy = await problems.getByTestId("finding-error-copy").evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect.soft(errorCopy.scrollWidth, width + "px: long error lines have bounded width").toBeLessThanOrEqual(errorCopy.width + 1);
      expect.soft(errorCopy.height, width + "px: error copy is bounded inside its callout").toBeLessThanOrEqual(96);
      expect.soft(errorCopy.scrollHeight, width + "px: long error copy remains reachable by scrolling").toBeGreaterThan(errorCopy.height);
      const tool = await problems.getByTestId("finding-tool").evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        text: element.textContent,
      }));
      expect.soft(tool.text, width + "px: long tool label is retained").toContain("longer_than_a_typical_tool_label");
      expect.soft(tool.scrollWidth, width + "px: long tool label stays bounded").toBeLessThanOrEqual(tool.width + 1);
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect.soft(pageOverflow, width + "px " + theme + ": long run detail does not create horizontal page overflow").toBe(false);
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-run-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
      await detail.getByTestId("evidence-chip-list").scrollIntoViewIfNeeded();
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-run-badges-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
      await detail.getByTestId("finding-tool").scrollIntoViewIfNeeded();
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-run-tool-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
      await detail.getByTestId("finding-error").scrollIntoViewIfNeeded();
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-run-error-detail-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
    }
  }
});

test("Sidebar steering and theme controls explain their effect", async ({ page }, testInfo) => {
  for (const width of widths) {
    for (const theme of themes) {
      await openWithTheme(page, "home", theme, width);
      if (width === 390) await page.getByRole("button", { name: "Open navigation" }).click();
      const steeringLabel = page.getByText("steering", { exact: true });
      await expect(steeringLabel).toBeVisible();
      await steeringLabel.hover();
      await page.waitForTimeout(700);
      const steeringTip = await page.getByRole("tooltip").allTextContents();
      expect.soft(steeringTip.join(" "), width + "px " + theme + ": steering tooltip explains when the agent is nudged").toMatch(/check fires mid-run/i);
      const themeButton = page.locator('button[aria-label^="Theme:"]');
      await expect(themeButton).toBeVisible();
      await themeButton.hover();
      await page.waitForTimeout(700);
      const themeTips = await page.getByRole("tooltip").allTextContents();
      expect.soft(themeTips.join(" "), width + "px " + theme + ": theme tooltip explains the monitor control").toMatch(/follows your device|system, light, and dark/i);
      await page.screenshot({ path: capturePath(testInfo, capturePrefix + "-sidebar-tooltip-" + width + "-" + theme + "-" + testInfo.repeatEachIndex + ".png"), fullPage: true });
    }
  }
});
