import { expect, test } from "@playwright/test";
import { api, open, watchErrors } from "./util";
import type { AmbientStatus } from "../src/lib/api";

const reset = () => api("/api/settings", { method: "POST", body: JSON.stringify({ ambient_enabled: false, ambient_log_enabled: false, ambient_chroma_enabled: false, ambient_chroma_animation: false, ambient_chroma_devices: ["chromalink"] }) });
const status = async () => (await api<{ ambient: AmbientStatus }>("/api/status")).ambient;
test.beforeEach(reset);
test.afterEach(reset);

test("ambient outputs require both opt-ins and the kill switch preserves output preference", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, "settings/ambient");
  const enable = page.getByRole("switch", { name: "Enable ambient outputs" });
  const logging = page.getByRole("switch", { name: "Log run status" });
  const save = page.getByRole("button", { name: "Save ambient settings" });
  await expect(enable).not.toBeChecked(); await expect(logging).not.toBeChecked();
  await expect(page.getByText("Inactive", { exact: true })).toBeVisible();
  await logging.click(); await save.click();
  await expect.poll(status).toMatchObject({ enabled: false, log_enabled: true, subscribed: false, state: "inactive" });
  await enable.click(); await save.click();
  await expect.poll(status).toMatchObject({ enabled: true, log_enabled: true, subscribed: true });
  await enable.click(); await save.click();
  await expect.poll(status).toMatchObject({ enabled: false, log_enabled: true, subscribed: false, state: "inactive" });
  await page.reload(); await expect(logging).toBeChecked(); await expect(enable).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("ambient Settings uses bounded accessible controls in light, dark and narrow layouts", async ({ page }, testInfo) => {
  await open(page, "settings/ambient");
  for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 390]] as const) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate((value) => localStorage.setItem("neatroots-theme", value), theme);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ambient outputs", level: 1 })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Log run status" })).toBeVisible();
    await expect(page.getByText("No output is active.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const screenshot = testInfo.outputPath(`ambient-${theme}-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`ambient-${theme}-${width}`, { path: screenshot, contentType: "image/png" });
  }
});


test("Chroma preferences save independently and refused saves preserve the draft", async ({ page }) => {
  await open(page, "settings/ambient");
  const lighting = page.getByRole("switch", { name: "Enable Chroma lighting" });
  const motion = page.getByRole("switch", { name: "Animate run state" });
  const keyboard = page.getByRole("checkbox", { name: "Keyboard", exact: true });
  const save = page.getByRole("button", { name: "Save ambient settings" });
  await lighting.click(); await motion.click(); await keyboard.click();
  await page.route("**/api/settings", route => route.request().method() === "POST"
    ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic refusal" }) }) : route.continue());
  await save.click();
  await expect(page.getByText(/Couldn't save settings/)).toBeVisible();
  await expect(lighting).toBeChecked(); await expect(motion).toBeChecked(); await expect(keyboard).toBeChecked();
  await expect(save).toBeEnabled();
  await page.unroute("**/api/settings"); await save.click();
  await expect.poll(status).toMatchObject({ enabled: false, chroma: { configured: true, animation: true, devices: ["chromalink", "keyboard"], phase: "inactive" } });
  await page.reload();
  await expect(lighting).toBeChecked(); await expect(motion).toBeChecked(); await expect(keyboard).toBeChecked();
  await expect(page.getByRole("switch", { name: "Enable ambient outputs" })).not.toBeChecked();
});
