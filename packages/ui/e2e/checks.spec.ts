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
    await expect(sheet.getByText(/Each finding counts once after it is raised or made active/)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Edit a copy" })).toBeVisible();
  });

  test("explains which finding rows count toward precision", async ({ page }) => {
    await open(page, "checks");
    await expect(page.getByRole("columnheader", { name: "Findings" })).toHaveAttribute("title", /raised or made active/);
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

  test("search narrows the table", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("textbox", { name: "Search checks" }).fill("secret");
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await expect(page.getByText("runaway-loop")).toHaveCount(0);
  });
});
