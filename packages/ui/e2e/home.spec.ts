import { expect, test } from "@playwright/test";
import { open } from "./util";

test.describe("home", () => {
  test("shows the period's numbers and what needs attention", async ({ page }) => {
    await open(page, "home");
    await expect(page.getByText("Runs", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Runs with problems")).toBeVisible();
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.getByText("Working well")).toBeVisible();
  });

  test("the setup guide checks steps against what is set up", async ({ page }) => {
    await open(page, "home");
    // Collapsed once the essentials are set up, expanded otherwise; wait for either.
    const show = page.getByRole("button", { name: "Show setup steps" });
    await expect(show.or(page.getByText("How to use neatroots"))).toBeVisible();
    if (await show.isVisible()) await show.click();
    await expect(page.getByText("How to use neatroots")).toBeVisible();
    await expect(page.getByText("Send your agent's runs to neatroots")).toBeVisible();
  });

  test("switching the period keeps the page working", async ({ page }) => {
    await open(page, "home");
    await page.getByRole("tab", { name: "24 hours" }).click();
    await expect(page.getByText("Runs with problems")).toBeVisible();
    await page.getByRole("tab", { name: "30 days" }).click();
    await expect(page.getByText("Runs with problems")).toBeVisible();
  });
});
