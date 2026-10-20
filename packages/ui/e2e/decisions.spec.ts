import { expect, test } from "@playwright/test";
import { open } from "./util";

test.describe("how checks get answered", () => {
  test("Home explains Laya before anything downloads, and offers Jev cloud instead", async ({ page }) => {
    await open(page, "home");
    const show = page.getByRole("button", { name: "Show setup steps" });
    await expect(show.or(page.getByText("How to use neatroots"))).toBeVisible();
    if (await show.isVisible()) await show.click();
    const step = page.getByRole("button", { name: /Choose how checks get answered/ });
    if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
    await expect(page.getByText(/one-time download of about 1\.4 GB/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Download Laya" })).toBeVisible();
    await page.getByRole("link", { name: "Set up Jev cloud" }).click();
    await expect(page).toHaveURL(/#\/settings\/decisions/);
    await expect(page.getByText("Jev cloud").first()).toBeVisible();
  });

  test("Skip Laya records the choice and keeps Download Laya for later", async ({ page }) => {
    await open(page, "settings/decisions");
    await expect(page.getByRole("button", { name: "Download Laya" })).toBeVisible();
    // A repeat finds the choice already made, so Skip is gone; either way the outcome is the same.
    const skip = page.getByRole("button", { name: "Skip Laya" });
    if (await skip.isVisible()) await skip.click();
    await expect(page.getByText(/You chose not to download Laya/)).toBeVisible();
    await expect(skip).toBeHidden();
    await expect(page.getByRole("button", { name: "Download Laya" })).toBeVisible();
  });
});
