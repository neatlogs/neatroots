import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { api, open, state } from "./util";

// Each test writes its own checks file into the e2e home and removes it afterwards, so the tests
// don't depend on each other and pass when repeated.
function writeChecks(name: string, text: string): string {
  const dir = path.join(state().home, "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

async function deleteFromSheet(page: Page, id: string): Promise<void> {
  await open(page, "checks");
  await page.getByRole("textbox", { name: "Search checks" }).fill(id);
  await page.getByText(id, { exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Delete check" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete check" }).click();
}

test.describe("deleting a check", () => {
  test("keeps the other checks and comments in its file", async ({ page }) => {
    const n = Date.now().toString(36);
    const keep = `# team checks\n- id: e2e-keep-${n}\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 50}\n`;
    const file = writeChecks(`e2e-delete-${n}.yaml`, `${keep}- id: e2e-gone-${n}\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 60}\n`);
    try {
      await api("/api/checks/reload", { method: "POST" });
      await deleteFromSheet(page, `e2e-gone-${n}`);
      await expect(page.getByText(`Deleted check e2e-gone-${n}`)).toBeVisible();
      expect(fs.readFileSync(file, "utf8")).toBe(keep);
    } finally {
      fs.rmSync(file, { force: true });
      await api("/api/checks/reload", { method: "POST" });
    }
  });

  test("says why when another check uses its YAML anchor, and changes nothing", async ({ page }) => {
    const n = Date.now().toString(36);
    const text = `- id: e2e-owner-${n}\n  kind: rule\n  rule: &shared {type: count, span: {type: tool}, at_least: 70}\n- id: e2e-borrower-${n}\n  kind: rule\n  rule: *shared\n`;
    const file = writeChecks(`e2e-anchor-${n}.yaml`, text);
    try {
      await api("/api/checks/reload", { method: "POST" });
      await deleteFromSheet(page, `e2e-owner-${n}`);
      await expect(page.getByText(`Couldn't delete the check: can't delete check e2e-owner-${n}`)).toBeVisible();
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "Search checks" }).fill(`e2e-owner-${n}`);
      await expect(page.getByText(`e2e-owner-${n}`, { exact: true }).first()).toBeVisible();
    } finally {
      fs.rmSync(file, { force: true });
      await api("/api/checks/reload", { method: "POST" });
    }
  });
});
