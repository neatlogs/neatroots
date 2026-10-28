import { expect, test } from "@playwright/test";
import { state } from "./util";

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}: interpretation, configured model and visible activity`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.stats.runs = 14;
        data.engine.llm = { ok: true, model: width === 390 ? "hosted-test-model" : "llama3.2:latest", where: width === 390 ? "test-provider" : "local", busy: 0 };
        await route.fulfill({ json: data });
      });
      await page.route("**/api/projects", (route) => route.fulfill({ json: { projects: ["support-agent", "example-chat-session", "example-replay", "four", "five"].map((project) => ({ project, runs: 2, with_findings: 0, last_ms: Date.now(), settings: { steering: "off", forward: false }, rerun: null })) } }));
      await page.route("**/api/insights?*", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.totals.runs = 14;
        data.buckets = [
          { start_ms: 1, runs: 8, with_problems: 0, failed: 0 },
          { start_ms: 2, runs: 6, with_problems: 2, failed: 0 },
          { start_ms: 3, runs: 0, with_problems: 0, failed: 0 },
        ];
        data.digest = { window: "7d", runs: 14, model: "test", where: "local", created_ms: Date.now(), insights: [{ tone: "bad", text: "example-chat-session" }, { tone: "good", text: "support-agent" }] };
        data.digest_pending = false;
        data.projects = [{ name: "example-chat-session", runs: 8, failed: 0, with_problems: 0, prev_runs: 0, prev_with_problems: 0, last_ms: Date.now(), top_problem: null }];
        await route.fulfill({ json: data });
      });
      await page.goto(`${state().url}/#/home`);
      await page.evaluate((value) => { document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
      const label = page.getByText("AI interpretation of aggregate data. It may disagree with the measured totals on this page.");
      await expect(label).toBeVisible();
      const bounds = await label.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect(page.getByText("example-chat-session", { exact: true }).first()).toBeVisible();
      const show = page.getByRole("button", { name: "Show setup steps" });
      if (await show.isVisible()) await show.click();
      await expect(page.getByText("14 runs from 5 projects (support-agent, example-chat-session, example-replay, and 2 more)")).toBeAttached();
      await page.getByRole("button", { name: /Give neatroots an LLM/ }).click();
      await expect(page.getByText(width === 390 ? "hosted-test-model is available through test-provider for questions, explanations and summaries." : "llama3.2:latest is available on this machine for questions, explanations and summaries.")).toBeVisible();
      await expect(page.getByText("ollama pull qwen3:8b", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Settings → Models", exact: true })).toBeVisible();
      const chart = page.getByRole("img", { name: /Runs per/ });
      const bars = chart.locator(":scope > div > div");
      await expect(bars).toHaveCount(4);
      const styles = await bars.evaluateAll((nodes) => nodes.map((node) => ({ color: getComputedStyle(node).backgroundColor, height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })));
      for (const style of styles) {
        expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(style.width).toBeGreaterThan(0);
        expect(style.height).toBeGreaterThan(0);
      }
      expect(styles[0].height / (styles[1].height + styles[2].height)).toBeCloseTo(8 / 6, 1);
      expect(styles[3].height).toBe(1);
      const swatch = page.getByText("no problems", { exact: true }).locator("span");
      await expect(swatch).toBeVisible();
      expect(await swatch.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(styles[0].color);
      await chart.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("activity.png"), fullPage: true });
    });
  }
}

test("the AI interpretation note shows only above a summary", async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    const data = await (await route.fetch()).json();
    data.engine.llm = { ok: false, model: null, where: "local", busy: 0 };
    await route.fulfill({ json: data });
  });
  await page.route("**/api/insights?*", async (route) => {
    const data = await (await route.fetch()).json();
    data.digest = null;
    data.digest_pending = false;
    await route.fulfill({ json: data });
  });
  await page.goto(`${state().url}/#/home`);
  await expect(page.getByText(/With an LLM available, neatroots writes a short summary/)).toBeVisible();
  await expect(page.getByText(/AI interpretation of aggregate data/)).toHaveCount(0);
});
