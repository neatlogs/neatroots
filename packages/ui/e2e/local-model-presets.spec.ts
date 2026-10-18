import { expect, test } from "@playwright/test";
import { api, open, state } from "./util";

test("local presets edit a draft, preserve the model and save only local settings", async ({ page }) => {
  const before = await api<any>("/api/status");
  const hosted = before.config.llm.external;
  try {
    await open(page, "settings/models");
    await page.getByText("Change the local server", { exact: true }).click();
    await page.locator("#llm-model").fill("my-manual-model");
    await page.getByRole("button", { name: "Razer AIKit", exact: true }).click();
    await expect(page.locator("#llm-url")).toHaveValue("http://localhost:8000/v1");
    await expect(page.locator("#llm-model")).toHaveValue("my-manual-model");
    const unsaved = await api<any>("/api/status");
    expect(unsaved.config.llm.baseUrl).toBe(before.config.llm.baseUrl);
    expect(unsaved.config.llm.model).toBe(before.config.llm.model);
    await page.getByRole("button", { name: "Ollama", exact: true }).click();
    await expect(page.locator("#llm-url")).toHaveValue("http://localhost:11434/v1");
    await expect(page.locator("#llm-model")).toHaveValue("my-manual-model");
    await page.locator("#llm-url").fill("http://localhost:18765/v1");
    await page.getByRole("button", { name: "Save local server", exact: true }).click();
    await expect(page.getByText("Local LLM saved", { exact: true })).toBeVisible();
    const saved = await api<any>("/api/status");
    expect(saved.config.llm.baseUrl).toBe("http://localhost:18765/v1");
    expect(saved.config.llm.model).toBe("my-manual-model");
    expect(saved.config.llm.external).toEqual(hosted);
    await page.reload();
    await page.getByText("Change the local server", { exact: true }).click();
    await expect(page.locator("#llm-model")).toHaveValue("my-manual-model");
  } finally {
    await api("/api/settings", { method: "POST", body: JSON.stringify({ llm_base_url: before.config.llm.baseUrl, llm_model: before.config.llm.model }) });
  }
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`local presets ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.goto(`${state().url}/#/settings/models`);
    await expect(page.getByRole("heading", { name: "LLM", exact: true })).toBeVisible();
    await page.evaluate(t => { document.documentElement.classList.toggle("dark", t === "dark"); document.documentElement.style.colorScheme = t; }, theme);
    await page.getByText("Change the local server", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Razer AIKit", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ollama", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`local-presets-${theme}-${width}.png`), fullPage: true });
  });
}
