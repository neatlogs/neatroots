import { expect, test } from "@playwright/test";
import { state, watchErrors } from "./util";

test("Decision model labels default-definition trust without claiming runtime calibration", async ({ page }, info) => {
  const errors = watchErrors(page);
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${state().url}/#/settings/decisions`);
      await expect(page.getByRole("heading", { name: "Decision model", level: 1 })).toBeVisible();
      await page.evaluate(value => { localStorage.setItem("neatroots-theme", value); }, theme);
      await page.reload();
      const scope = page.getByText(/default question definitions\. Runtime parameters calibrate separately\./);
      await expect(scope).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`trust-${theme}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
