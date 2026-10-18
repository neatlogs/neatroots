import { expect, test } from "@playwright/test";
import { open, state, watchErrors } from "./util";

for (const edits of [false, true]) for (const commands of [false, true]) {
  test(`Codex permissions persist independently ${edits}/${commands}`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "agents");
    await page.getByPlaceholder("~/code/my-agent").fill(state().home);
    await page.getByRole("switch", { name: /^Allow edits\b/ }).setChecked(edits);
    await page.getByRole("switch", { name: /^Allow commands\b/ }).setChecked(commands);
    await page.getByRole("button", { name: "Start Codex" }).click();
    await expect(page).toHaveURL(/#\/agents\/chat_/);
    await expect(page.getByRole("switch", { name: /^Allow edits\b/ })).toBeChecked({ checked: edits });
    await expect(page.getByRole("switch", { name: /^Allow commands\b/ })).toBeChecked({ checked: commands });
    await page.reload();
    await expect(page.getByRole("switch", { name: /^Allow edits\b/ })).toBeChecked({ checked: edits });
    await expect(page.getByRole("switch", { name: /^Allow commands\b/ })).toBeChecked({ checked: commands });
    await page.getByRole("switch", { name: /^Allow edits\b/ }).click();
    await expect.poll(async () => page.getByRole("switch", { name: /^Allow edits\b/ }).isChecked()).toBe(!edits);
    await page.getByLabel("Message").fill("Show permission status");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("E2E_CHAT_OK")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
  test(`Codex permission layout ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.goto(`${state().url}/#/agents`);
    await expect(page.getByText("File edits control write access.", { exact: false })).toBeVisible();
    await expect(page.getByRole("switch", { name: /^Allow commands\b/ })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.getByRole("tab", { name: "Codex", exact: true }).evaluate((tab) => {
      const indicator = tab.querySelector(":scope > div");
      if (!indicator) return false;
      const a = tab.getBoundingClientRect(), b = indicator.getBoundingClientRect();
      return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
    })).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`permissions-${theme}-${width}.png`), fullPage: true });
    await page.getByPlaceholder("~/code/my-agent").fill(state().home);
    await page.getByRole("button", { name: "Start Codex" }).click();
    await expect(page.getByText("File edits and shell commands are controlled separately.", { exact: false })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`chat-permissions-${theme}-${width}.png`), fullPage: true });
  });
}
