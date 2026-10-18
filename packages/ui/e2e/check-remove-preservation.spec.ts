import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, state, watchErrors } from "./util";

for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
  test(`anchor refusal preserves both checks and shows its error (${theme}, ${width})`, async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width, height: 960 });
    await page.addInitScript(choice => localStorage.setItem("neatroots-theme", choice), theme);
    const suffix = crypto.randomBytes(4).toString("hex");
    const owner = `delete-owner-${suffix}`, borrower = `delete-borrower-${suffix}`;
    const folder = fs.mkdtempSync(path.join(state().home, "delete-check-"));
    const file = path.join(folder, "checks.yaml");
    const original = `- id: ${owner}\n  kind: rule\n  rule: &shared {type: count, span: {type: tool}, at_least: 1}\n- id: ${borrower}\n  kind: rule\n  rule: *shared\n`;
    fs.writeFileSync(file, original);
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ check_dir: folder }) });
      await page.goto(`${state().url}/#/checks`);
      await expect(page.getByRole("button", { name: "New check", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);
      if (width >= 640) await page.getByRole("textbox", { name: "Search checks" }).fill(owner);
      const label = page.getByText(owner, { exact: true }).first();
      await label.scrollIntoViewIfNeeded();
      await label.click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete check", exact: true }).click();
      const response = page.waitForResponse(r => r.url().endsWith(`/api/checks/${owner}`) && r.request().method() === "DELETE");
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete check", exact: true }).click();
      expect((await response).status()).toBe(409);
      const toast = page.getByText(/Couldn't delete the check:.*uses its YAML anchor/);
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(borrower);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      const result = await api<{ checks: { id: string }[] }>("/api/checks");
      expect(result.checks.map(c => c.id)).toEqual(expect.arrayContaining([owner, borrower]));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`delete-refusal-${theme}-${width}.png`), animations: "disabled" });
      expect(errors).toEqual([]);
      await api(`/api/checks/${borrower}`, { method: "DELETE" });
      await api(`/api/checks/${owner}`, { method: "DELETE" });
    } finally {
      // Restrict cleanup to this test's own checks; API deletion refreshes the registry.
      for (const id of [borrower, owner]) await fetch(`${state().url}/api/checks/${id}`, { method: "DELETE" });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
}
