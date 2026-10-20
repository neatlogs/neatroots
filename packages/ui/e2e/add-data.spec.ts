import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { open, state } from "./util";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/import-files");

test.describe("add data", () => {
  test("shows every way to send runs, pointed at this server", async ({ page }) => {
    await open(page, "add-data");
    const port = new URL(state().url).port;
    await expect(page.getByText(`NEATLOGS_ENDPOINT=http://localhost:${port}`).first()).toBeVisible();
    for (const t of ["Neatlogs SDK", "Browser SDK", "HTTP trace API", "OpenTelemetry (OTLP)"]) await expect(page.getByText(t, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "TypeScript" }).click();
    await expect(page.getByText(/npm install neatlogs/)).toBeVisible();
  });

  test("imports trace files", async ({ page }) => {
    await open(page, "add-data/import");
    await page.locator('input[type="file"]').setInputFiles([path.join(examples, "otlp-trace.json"), path.join(examples, "http-traces.jsonl")]);
    await expect(page.getByText(/otlp-trace\.json: 1 run/)).toBeVisible();
    await expect(page.getByText(/http-traces\.jsonl: 2 runs/)).toBeVisible();
    await open(page, "runs");
    await expect(page.getByRole("cell", { name: "Plan a weekend in Kyoto" })).toBeVisible();
  });

  test("the import tab takes trace files only", async ({ page }) => {
    await open(page, "add-data/import");
    await expect(page.getByRole("tab", { name: "Import files" })).toBeVisible();
    await expect(page.getByText("Drop trace files here")).toBeVisible();
    await expect(page.getByText(/neatroots import traces\.json/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up import" })).toHaveCount(0);
  });

  test("Neatlogs Cloud import asks for a service-account token first", async ({ page }) => {
    await open(page, "add-data/cloud");
    await expect(page.getByText("Connect Neatlogs Cloud")).toBeVisible();
    await expect(page.getByText(/service-account token/)).toBeVisible();
    await page.getByRole("button", { name: "Add token" }).click();
    await expect(page).toHaveURL(/#\/settings\/cloud/);
    await expect(page.getByRole("button", { name: "Store token" })).toBeDisabled();
  });
});
