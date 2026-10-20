import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { api, open, state } from "./util";

async function openDiagnosticDialog(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Prepare diagnostic export" }).click();
  await expect(page.getByRole("menuitem", { name: "Prepare diagnostic export" })).toBeHidden();
  const dialog = page.getByRole("dialog", { name: "Prepare diagnostic export" });
  const preview = page.getByTestId("diagnostic-export-preview");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.evaluate(() => {
    const activeAnimations = document.getAnimations().filter((animation) => animation.playState === "running");
    const dialogElement = document.querySelector('[role="dialog"]');
    const bounds = dialogElement?.getBoundingClientRect();
    return activeAnimations.length === 0 && !!bounds && bounds.width > 0 && bounds.height > 0;
  })).toBe(true);
  return { dialog, preview };
}

async function expectDialogContentsFit(page: Page) {
  const bounds = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!dialog) return { counterCount: 0, countersFit: false, counterTextFits: false, buttonCount: 0, buttonsFit: false, buttonTextFits: false };
    const dialogBounds = dialog.getBoundingClientRect();
    const withinDialogAndViewport = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        box.left >= dialogBounds.left - 1 && box.right <= dialogBounds.right + 1 &&
        box.top >= dialogBounds.top - 1 && box.bottom <= dialogBounds.bottom + 1 &&
        box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
    };
    const counters = [...dialog.querySelectorAll<HTMLElement>('[aria-label="Export contents"] > div')];
    const buttons = [...dialog.querySelectorAll<HTMLElement>("button")];
    return {
      counterCount: counters.length,
      countersFit: counters.length === 3 && counters.every(withinDialogAndViewport),
      counterTextFits: counters.every((counter) => counter.scrollWidth <= counter.clientWidth + 1),
      buttonCount: buttons.length,
      buttonsFit: buttons.length >= 3 && buttons.every(withinDialogAndViewport),
      buttonTextFits: buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
    };
  });
  expect(bounds.counterCount).toBe(3);
  expect(bounds.countersFit).toBe(true);
  expect(bounds.counterTextFits).toBe(true);
  expect(bounds.buttonsFit).toBe(true);
  expect(bounds.buttonTextFits).toBe(true);
}

async function showExport(page: Page) {
  await open(page, `runs/${state().supportRun}`);
  return openDiagnosticDialog(page);
}

async function prepareRunWithTheme(page: Page, theme: "light" | "dark") {
  const existingDialog = page.getByRole("dialog", { name: "Prepare diagnostic export" });
  if (await existingDialog.isVisible().catch(() => false)) {
    await existingDialog.getByRole("button", { name: "Close" }).first().click();
    await expect(existingDialog).not.toBeVisible();
  }

  await open(page, `runs/${state().supportRun}`);
  const themeButton = page.getByRole("button", { name: /^Theme:/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const label = await themeButton.getAttribute("aria-label");
    if (label?.startsWith(`Theme: ${theme}.`)) break;
    await themeButton.click();
  }
  await expect(themeButton).toHaveAttribute("aria-label", new RegExp(`^Theme: ${theme}\\.`));
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
}

async function showExportWithTheme(page: Page, theme: "light" | "dark") {
  await prepareRunWithTheme(page, theme);
  return openDiagnosticDialog(page);
}

test.describe("local diagnostic export", () => {
  test("bounds the rendered preview while downloading the complete sanitized bundle", async ({ page }) => {
    const bundle = { format: "neatroots.diagnostic-export", schema_version: 1, trace: { payload: "x".repeat(100_000) }, redactions: { matches: [] } };
    await page.route("**/api/runs/*/diagnostic-export", (route) => route.fulfill({ json: { bundle, preview: { span_count: 1, finding_count: 0, check_count: 0 } } }));
    const { dialog, preview } = await showExport(page);
    expect((await preview.textContent())!.length).toBe(32 * 1024);
    await expect(dialog.getByText("Preview shows the first 32 Ki characters.", { exact: false })).toBeVisible();
    const downloadWait = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download diagnostic bundle" }).click();
    const download = await downloadWait;
    expect(download.suggestedFilename()).toMatch(/^neatroots-diagnostic-[a-f0-9]{12}\.json$/);
    expect(download.suggestedFilename()).not.toContain(state().supportRun.slice(0, 12));
    expect(await fs.promises.readFile(await download.path(), "utf8")).toBe(JSON.stringify(bundle));
  });

  test("shows an oversized-export refusal and keeps the dialog usable", async ({ page }) => {
    const message = "Diagnostic export is too large. The limit is 2 MiB of source data and 4 MiB of JSON. Choose a smaller run.";
    await page.route("**/api/runs/*/diagnostic-export", (route) => route.fulfill({ status: 413, json: { error: message } }));
    await open(page, `runs/${state().supportRun}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Prepare diagnostic export" }).click();
    const dialog = page.getByRole("dialog", { name: "Prepare diagnostic export" });
    await expect(dialog.getByRole("alert")).toContainText(message);
    await expect(dialog.getByRole("button", { name: "Download diagnostic bundle" })).toBeDisabled();
    await expect(page.getByTestId("diagnostic-export-preview")).toHaveCount(0);
    // The primitive appends an icon Close with screen-reader text after the footer.
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog).toBeHidden();
  });

  test("shows the sanitized bundle and downloads exactly that preview without forwarding", async ({ page }) => {
    const externalRequests: string[] = [];
    const localOrigin = new URL(state().url).origin;
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== localOrigin) externalRequests.push(request.url());
    });
    const { dialog, preview } = await showExport(page);
    const shown = (await preview.textContent())?.trim() ?? "";
    const bundle = JSON.parse(shown) as { format: string; schema_version: number; redactions: { matches: { kind: string; count: number }[] } };
    expect(bundle).toMatchObject({ format: "neatroots.diagnostic-export", schema_version: 1 });
    expect(shown).toContain("[redacted:api_key]");
    expect(shown).not.toContain("sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c");
    await expect(dialog.getByText(/Nothing is uploaded/)).toBeVisible();

    const downloadWait = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download diagnostic bundle" }).click();
    const download = await downloadWait;
    expect(await fs.promises.readFile(await download.path(), "utf8")).toBe(shown);
    expect(download.suggestedFilename()).toMatch(/^neatroots-diagnostic-[a-f0-9]{12}\.json$/);
    expect(externalRequests).toEqual([]);
  });

  test("keeps redacted trace identities out of actual download filenames", async ({ page }) => {
    const traceId = state().supportRun;
    await api("/api/settings", { method: "POST", body: JSON.stringify({ redact_patterns: ["^[a-f0-9]+$"] }) });
    try {
      const { dialog, preview } = await showExport(page);
      const shown = (await preview.textContent())!.trim();
      const bundle = JSON.parse(shown) as { run: { trace_id: string } };
      expect(bundle.run.trace_id).toMatch(/^[a-f0-9]{32}$/);
      expect(bundle.run.trace_id).not.toBe(traceId);
      expect(shown).not.toContain(traceId);
      const downloadWait = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Download diagnostic bundle" }).click();
      const download = await downloadWait;
      expect(download.suggestedFilename()).toMatch(/^neatroots-diagnostic-[a-f0-9]{12}\.json$/);
      expect(download.suggestedFilename()).not.toContain(traceId.slice(0, 12));
      expect(await fs.promises.readFile(await download.path(), "utf8")).toBe(shown);
    } finally {
      // This isolated e2e server starts with the default empty custom-pattern list.
      await api("/api/settings", { method: "POST", body: JSON.stringify({ redact_patterns: [] }) });
    }
  });

  test("renders the redaction preview in light, dark and 390px layouts", async ({ page }, testInfo) => {
    await fs.promises.mkdir(testInfo.outputDir, { recursive: true });
    let { dialog, preview } = await showExportWithTheme(page, "light");
    await expect(dialog.getByRole("button", { name: "Download diagnostic bundle" })).toBeEnabled();
    await expectDialogContentsFit(page);
    const desktopSummary = await dialog.locator('[aria-label="Export contents"]').evaluate((element) => (element as HTMLElement).scrollWidth);
    expect(desktopSummary).toBeLessThanOrEqual(await dialog.locator('[aria-label="Export contents"]').evaluate((element) => (element as HTMLElement).clientWidth));
    await page.screenshot({ path: testInfo.outputPath("diagnostic-export-light.png"), animations: "disabled" });

    ({ dialog, preview } = await showExportWithTheme(page, "dark"));
    await expectDialogContentsFit(page);
    await page.screenshot({ path: testInfo.outputPath("diagnostic-export-dark.png"), animations: "disabled" });

    await prepareRunWithTheme(page, "light");
    await page.setViewportSize({ width: 390, height: 844 });
    ({ dialog, preview } = await openDiagnosticDialog(page));
    await expect(preview).toBeVisible();
    const downloadButton = dialog.getByRole("button", { name: "Download diagnostic bundle" });
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toBeEnabled();
    await expect(downloadButton).toBeInViewport();
    const responsiveLayout = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const bounds = dialog.getBoundingClientRect();
      const summary = dialog.querySelector('[aria-label="Export contents"]') as HTMLElement;
      const preview = dialog.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
      const downloadButton = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Download diagnostic bundle")) as HTMLButtonElement;
      const downloadBounds = downloadButton.getBoundingClientRect();
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        dialogLeft: bounds.left,
        dialogRight: bounds.right,
        dialogTop: bounds.top,
        dialogBottom: bounds.bottom,
        summaryWidth: summary.clientWidth,
        summaryScrollWidth: summary.scrollWidth,
        previewClientHeight: preview.clientHeight,
        previewScrollHeight: preview.scrollHeight,
        previewClientWidth: preview.clientWidth,
        previewScrollWidth: preview.scrollWidth,
        downloadTop: downloadBounds.top,
        downloadBottom: downloadBounds.bottom,
      };
    });
    expect(responsiveLayout.pageWidth).toBe(responsiveLayout.viewportWidth);
    expect(responsiveLayout.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(responsiveLayout.dialogRight).toBeLessThanOrEqual(responsiveLayout.viewportWidth);
    expect(responsiveLayout.dialogTop).toBeGreaterThanOrEqual(0);
    expect(responsiveLayout.dialogBottom).toBeLessThanOrEqual(844);
    expect(responsiveLayout.summaryScrollWidth).toBeLessThanOrEqual(responsiveLayout.summaryWidth);
    expect(responsiveLayout.previewScrollWidth).toBeLessThanOrEqual(responsiveLayout.previewClientWidth);
    expect(responsiveLayout.previewScrollHeight).toBeGreaterThan(responsiveLayout.previewClientHeight);
    expect(responsiveLayout.downloadTop).toBeGreaterThanOrEqual(0);
    expect(responsiveLayout.downloadBottom).toBeLessThanOrEqual(844);
    await expectDialogContentsFit(page);
    await page.screenshot({ path: testInfo.outputPath("diagnostic-export-390px.png"), animations: "disabled" });
  });
});
