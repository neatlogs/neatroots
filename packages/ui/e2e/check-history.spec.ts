import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { open, state } from "./util";

test("check history retains edited definitions and run provenance is read-only", async ({ page, request }, info) => {
  const id = `history-e2e-${crypto.randomBytes(6).toString("hex")}`;
  const url = state().url;
  const save = async (title: string) => {
    const response = await request.post(`${url}/api/checks`, { data: { id, title, kind: "rule", rule: { type: "count", at_least: 1 } } });
    expect(response.ok()).toBeTruthy();
  };
  await save("Original history definition");
  await save("Edited history definition");
  try {
    await open(page, "checks");
    await page.getByRole("textbox", { name: "Search checks" }).fill(id);
    await page.getByText(id, { exact: true }).click();
    const history = page.getByRole("region", { name: "Check history" });
    await expect(history.getByText("Definition history")).toBeVisible();
    await expect(history.locator("details")).toHaveCount(2);
    await history.locator("details").first().locator("summary").click();
    await expect(history.locator("pre").first()).toContainText("history-e2e-");
    await expect(history.getByRole("button")).toHaveCount(0);
    for (const [name, width, theme] of [["light", 1440, "light"], ["dark", 1440, "dark"], ["mobile", 390, "light"]] as const) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
      await page.screenshot({ path: info.outputPath(`check-history-${name}.png`), animations: "disabled" });
    }
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await open(page, `runs/${state().loopRun}`);
    const provenance = page.getByTestId("check-provenance");
    await expect(provenance.getByText("Check provenance", { exact: true })).toBeVisible();
    await expect(provenance.locator("details").first()).toBeVisible();
    await provenance.locator("summary").first().click();
    await expect(provenance).toContainText("Evidence SHA-256:");
    await expect(provenance.getByRole("button")).toHaveCount(0);
    for (const [name, width, theme] of [["light", 1440, "light"], ["dark", 1440, "dark"], ["mobile", 390, "light"]] as const) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
      // Crossing the breakpoint remounts DetailLayout's content; wait for that commit before scrolling.
      await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", width === 390 ? "stacked" : "split");
      await page.getByTestId("check-provenance").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("check-provenance")).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`run-provenance-${name}.png`), animations: "disabled" });
    }
  } finally {
    expect((await request.delete(`${url}/api/checks/${id}`)).ok()).toBeTruthy();
  }
});
