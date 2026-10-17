import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { api, open } from "./util";

test("rule preview shows a satisfied prerequisite as evaluated with no hit", async ({ page }, testInfo) => {
  const traces: string[] = [];
  const project = "preview-prerequisite-regression";
  try {
    for (const [name, tools] of [
      ["prerequisite-satisfied", ["lookup", "refund"]],
      ["prerequisite-missing", ["refund"]],
    ] as const) {
      const run = await api<{ trace_id: string }>("/v1/trace", {
        method: "POST",
        body: JSON.stringify({ name, project, output: "done", children: tools.map((tool) => ({ name: tool, tool_name: tool, duration_ms: 10, output: "ok" })) }),
      });
      traces.push(run.trace_id);
    }
    await open(page, "checks");
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("textbox", { name: "Check (YAML)" }).fill([
      "id: preview-prerequisite-regression", "kind: rule", `applies_to: { project: ${project} }`,
      "rule:", "  type: requires_before", "  span: { tool: refund }", "  requires: { tool: lookup }", "",
    ].join("\n"));
    await sheet.getByRole("button", { name: "Preview on recent runs" }).click();
    await expect(sheet.getByText("Fires on 1 of 2 evaluated runs · hit rate 50%")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "prerequisite-satisfied: Evaluated; no hit", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "prerequisite-missing: Fired", exact: true })).toBeVisible();
    await expect(sheet.getByText(/runs were not evaluated/)).toHaveCount(0);
    const screenshotDir = process.env.PREVIEW_VERDICTS_SCREENSHOT_DIR;
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
        const background = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--background)";
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        });
        await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(background);
        await page.screenshot({ path: path.join(screenshotDir, `prerequisite-${theme}-${testInfo.repeatEachIndex}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(screenshotDir, `prerequisite-390px-${testInfo.repeatEachIndex}.png`) });
    }
  } finally {
    for (const trace of traces) await api(`/api/runs/${trace}`, { method: "DELETE" });
  }
});
