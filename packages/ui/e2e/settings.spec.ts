import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { api, open } from "./util";

type SteeringContactFixture = number | null | "legacy";

async function fixtureSteeringStatus(page: Page, lastSeenMs: SteeringContactFixture): Promise<void> {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json() as { steering: Record<string, unknown> };
    const steering = { ...status.steering };
    if (lastSeenMs === "legacy") {
      steering.hooks_connected = 2;
      delete steering.stream_clients;
      delete steering.last_seen_ms;
    } else {
      steering.hooks_connected = 0;
      steering.stream_clients = 0;
      steering.last_seen_ms = lastSeenMs;
    }
    await route.fulfill({ response, json: { ...status, steering } });
  });
}

test.describe("settings", () => {
  test("every settings page renders under the settings navigation", async ({ page }) => {
    await open(page, "settings/general");
    for (const [link, title] of [
      ["Projects", "Projects"],
      ["LLM", "LLM"],
      ["Decision model", "Decision model"],
      ["Coding agents", "Coding agents"],
      ["Neatlogs Cloud", "Neatlogs Cloud"],
      ["General", "General"],
    ] as const) {
      await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    }
  });

  test("General shows the endpoints and saves retention", async ({ page }) => {
    await open(page, "settings/general");
    await expect(page.getByText("/mcp").first()).toBeVisible();
    await page.getByRole("spinbutton", { name: /Keep runs for/ }).fill("21");
    await page.getByRole("button", { name: "Save retention" }).click();
    await expect(page.getByText("Retention saved")).toBeVisible();
    const s = await api<{ config: { retention: { days: number } } }>("/api/status");
    expect(s.config.retention.days).toBe(21);
  });

  test("Projects shows hook setup without a health assessment", async ({ page }, testInfo) => {
    await fixtureSteeringStatus(page, null);
    await open(page, "settings/projects");
    await expect(page.getByText("Steering hook", { exact: true })).toBeVisible();
    await expect(page.getByText(/Last successful hook contact|SSE stream|connected now/)).toHaveCount(0);
    await expect(page.getByText(/connected now/)).toHaveCount(0);

    const screenshotDir = process.env.NEATROOTS_HOOK_HEALTH_SCREENSHOT_DIR;
    if (screenshotDir && testInfo.repeatEachIndex === 0) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(screenshotDir, "settings-steering-light.png"), fullPage: true });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(screenshotDir, "settings-steering-dark.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(screenshotDir, "settings-steering-390px.png"), fullPage: true });
    }
  });

  test("Projects keeps contact telemetry out of hook setup", async ({ page }) => {
    await fixtureSteeringStatus(page, Date.now() - 120_000);
    await open(page, "settings/projects");
    await expect(page.getByText("Steering hook", { exact: true })).toBeVisible();
    await expect(page.getByText(/Last successful hook contact|SSE stream|connected now/)).toHaveCount(0);
  });

  test("Projects shows hook setup with legacy status", async ({ page }) => {
    await fixtureSteeringStatus(page, "legacy");
    await open(page, "settings/projects");
    await expect(page.getByText("Steering hook", { exact: true })).toBeVisible();
    await expect(page.getByText(/Last successful hook contact|SSE stream|connected now/)).toHaveCount(0);
  });

  test("Projects sets up a replay command for a project", async ({ page }) => {
    // Other tests expect e2e-support to have no replay command; leave it the way we found it.
    const clear = () => api("/api/projects/e2e-support/rerun", { method: "POST", body: "{}" });
    await clear();
    await open(page, "settings/projects");
    const row = page.getByRole("row", { name: /e2e-support/ });
    await row.getByRole("button", { name: "Set up" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Command" }).fill("python agent.py");
    await dialog.getByRole("button", { name: "Save replay" }).click();
    await expect(page.getByText("Replay set up for e2e-support")).toBeVisible();
    await expect(row.getByRole("button", { name: "Command" })).toBeVisible();
    await clear();
  });

  test("Projects changes a project's steering mode", async ({ page }) => {
    await open(page, "settings/projects");
    const row = page.getByRole("row", { name: /e2e-billing/ });
    await row.getByRole("combobox", { name: /Steering for/ }).click();
    await page.getByRole("option", { name: "Advisory" }).click();
    await expect(page.getByText("Steering for e2e-billing: advisory")).toBeVisible();
  });

  test("Coding agents lists the agents neatroots can connect", async ({ page }) => {
    await open(page, "settings/agents");
    for (const name of ["Claude Code", "Codex", "Cursor", "OpenCode", "Windsurf", "Gemini CLI", "VS Code"]) await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  });

  test("connecting Cursor writes its MCP config in the (test) home folder", async ({ page }) => {
    await open(page, "settings/agents");
    await page.getByRole("row", { name: /Cursor/ }).getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("row", { name: /Cursor/ }).getByText("Connected")).toBeVisible();
    await page.getByRole("row", { name: /Cursor/ }).getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("row", { name: /Cursor/ }).getByRole("button", { name: "Connect" })).toBeVisible();
  });

  test("Neatlogs Cloud asks for a key before anything can be sent", async ({ page }) => {
    await open(page, "settings/cloud");
    await expect(page.getByText("Not connected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Store key" })).toBeDisabled();
  });
});
