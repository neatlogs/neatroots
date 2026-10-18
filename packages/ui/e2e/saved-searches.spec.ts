import { expect, test } from "@playwright/test";
import { open } from "./util";

const key = "neatroots.saved-searches.v1";
test("save, rename, persist, open through palette and delete", async ({ page }) => {
  const query = '  delivered  project:e2e-support  ';
  await open(page, "search");
  await page.getByRole("textbox", { name: "Search runs" }).fill(query);
  await page.getByRole("textbox", { name: "Saved query name" }).fill("Support");
  await page.getByRole("button", { name: "Save query", exact: true }).click();
  await expect(page.getByRole("button", { name: "Support", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename Support", exact: true }).click();
  await page.getByRole("textbox", { name: "Saved query name" }).fill("Delivered");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Delivered", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search runs" }).fill("solar");
  await expect(page).toHaveURL(/q=solar/);
  await page.getByRole("textbox", { name: "Search runs" }).fill("pending draft");
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: "Open Delivered", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search runs" })).toHaveValue(query);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(query)}`));
  await page.waitForTimeout(350); // Allow the previous debounced input to settle.
  await expect(page.getByRole("textbox", { name: "Search runs" })).toHaveValue(query);
  await page.getByRole("button", { name: "Delete Delivered", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Delivered", exact: true })).toHaveCount(0);
});

test("empty names and duplicate names are rejected", async ({ page }) => {
  await open(page, "search");
  await page.getByRole("button", { name: "Save query", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a name and a query.");
  await page.getByRole("textbox", { name: "Search runs" }).fill("solar");
  await page.getByRole("textbox", { name: "Saved query name" }).fill("Research");
  await page.getByRole("button", { name: "Save query", exact: true }).click();
  await page.getByRole("textbox", { name: "Saved query name" }).fill(" research ");
  await page.getByRole("button", { name: "Save query", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A saved query already has this name.");
});

for (const value of ["{broken", JSON.stringify([null, { name: 2, query: "bad" }])]) {
  test(`malformed storage is ignored: ${value}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key, value });
    await open(page, "search");
    await expect(page.getByRole("textbox", { name: "Search runs" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  });
}

test("unavailable storage reports a failed save", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    Storage.prototype.setItem = () => { throw new Error("denied"); };
  });
  await open(page, "search?q=solar");
  await page.getByRole("textbox", { name: "Saved query name" }).fill("Research");
  await page.getByRole("button", { name: "Save query", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Browser storage is unavailable. Your changes were not saved.");
});

test("saved queries reach the existing API unchanged on each opening", async ({ page }) => {
  const queries: string[] = [];
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify([
    { name: "Recent", query: "since:24h" }, { name: "Invalid", query: "since:nonsense" },
  ])), { key });
  await page.route("**/api/search/runs?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q")!;
    queries.push(query);
    await route.fulfill({ status: query === "since:nonsense" ? 400 : 200, contentType: "application/json", body: query === "since:nonsense" ? JSON.stringify({ error: "Invalid since filter" }) : JSON.stringify({ total: 0, runs: [] }) });
  });
  await open(page, "search");
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect.poll(() => queries.filter((q) => q === "since:24h").length).toBe(1);
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect.poll(() => queries.filter((q) => q === "since:24h").length).toBe(2);
  await page.getByRole("button", { name: "Invalid", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid since filter");
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect.poll(() => queries.filter((q) => q === "since:24h").length).toBe(3);
});

for (const theme of ["light", "dark"] as const) {
  test(`saved queries layout ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(({ key, theme }) => {
      localStorage.setItem("neatroots-theme", theme);
      localStorage.setItem(key, JSON.stringify([{ name: "Failed in the last day", query: "status:failed since:24h" }]));
    }, { key, theme });
    await open(page, "search");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Delete Failed in the last day" })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${theme}-390.png`) });
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${theme}-palette-390.png`) });
  });
}
