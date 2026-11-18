import { expect, test } from "@playwright/test";
import { api, open } from "./util";

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

  test("Neatlogs Cloud saves, shows and clears extra redaction patterns", async ({ page }) => {
    await api("/api/settings", { method: "POST", body: JSON.stringify({ redact_patterns: [] }) });
    await open(page, "settings/cloud");
    const box = page.getByRole("textbox", { name: "Extra redaction patterns" });
    await expect(box).toHaveValue("");
    await box.fill("cust_[0-9]+");
    await page.getByRole("button", { name: "Save cloud settings" }).click();
    await expect(page.getByText("Cloud settings saved")).toBeVisible();
    const saved = await api<{ cloud: { redact_patterns: string[] } }>("/api/status");
    expect(saved.cloud.redact_patterns).toEqual(["cust_[0-9]+"]);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Extra redaction patterns" })).toHaveValue("cust_[0-9]+");
    await page.getByRole("textbox", { name: "Extra redaction patterns" }).fill("");
    await page.getByRole("button", { name: "Save cloud settings" }).click();
    await expect(page.getByText("Cloud settings saved")).toBeVisible();
    const cleared = await api<{ cloud: { redact_patterns: string[] } }>("/api/status");
    expect(cleared.cloud.redact_patterns).toEqual([]);
  });
});
