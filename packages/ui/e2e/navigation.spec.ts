import { expect, test } from "@playwright/test";
import { open, watchErrors } from "./util";

test.describe("app shell", () => {
  test("every page in the sidebar loads without errors", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "home");
    for (const [link, heading] of [
      ["runs", "Runs"],
      ["search", "Search"],
      ["checks", "Checks"],
      ["coding agents", "Coding agents"],
      ["add data", "Add data"],
      ["settings", "Settings"],
      ["home", "Home"],
    ] as const) {
      await page.getByRole("link", { name: link, exact: true }).click();
      await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("Cmd/Ctrl+K opens search from anywhere", async ({ page }) => {
    await open(page, "runs");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page).toHaveURL(/#\/search/);
    await expect(page.getByRole("textbox", { name: "Search runs" })).toBeFocused();
  });

  test("the theme button cycles light, dark and system", async ({ page }) => {
    await open(page, "home");
    const html = page.locator("html");
    const button = page.getByRole("button", { name: /^Theme:/ });
    await expect(button).toHaveAccessibleName(/^Theme: system/);
    await button.click();
    await expect(button).toHaveAccessibleName(/^Theme: light/);
    await expect(html).not.toHaveClass(/\bdark\b/);
    await button.click();
    await expect(button).toHaveAccessibleName(/^Theme: dark/);
    await expect(html).toHaveClass(/\bdark\b/);
    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await expect(page.getByRole("button", { name: /^Theme:/ })).toHaveAccessibleName(/^Theme: system/);
  });

  test("the live dot shows the event stream is connected", async ({ page }) => {
    await open(page, "home");
    await expect(page.getByText("live", { exact: true })).toBeVisible();
  });
});
