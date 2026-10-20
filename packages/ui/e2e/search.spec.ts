import { expect, test } from "@playwright/test";
import { open } from "./util";

test.describe("search", () => {
  test("finds runs by text and highlights the hits", async ({ page }) => {
    await open(page, "search");
    await page.getByRole("textbox", { name: "Search runs" }).fill("delivered");
    await expect(page.getByText(/\d+ runs?/).first()).toBeVisible();
    await expect(page.locator("mark").first()).toBeVisible();
    await expect(page).toHaveURL(/q=delivered/);
  });

  test("filters narrow the results", async ({ page }) => {
    await open(page, "search?q=solar%20project:e2e-research");
    await expect(page.getByRole("button", { name: /Write a note on solar batteries/ })).toBeVisible();
    await page.getByRole("textbox", { name: "Search runs" }).fill("solar project:e2e-support");
    await expect(page.getByText("Nothing matched")).toBeVisible();
  });

  test("quick filter chips add and remove tokens", async ({ page }) => {
    await open(page, "search");
    await page.getByRole("button", { name: "Failed", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search runs" })).toHaveValue("status:failed");
    await expect(page.getByRole("button", { name: /Refund invoice 77/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Is order 1001 ok/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Failed", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search runs" })).toHaveValue("");
  });

  test("a hit opens the run at that span", async ({ page }) => {
    await open(page, "search?q=lookup_order");
    await page.locator("li li").first().click();
    await expect(page).toHaveURL(/#\/runs\/[0-9a-f]{32}\?view=trace&span=/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
