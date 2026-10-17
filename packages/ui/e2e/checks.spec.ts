import { expect, test } from "@playwright/test";
import { open, state } from "./util";

test.describe("checks", () => {
  test("lists rules and questions, and filters by group", async ({ page }) => {
    await open(page, "checks");
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await page.getByRole("tab", { name: /^Rules/ }).click();
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await page.getByRole("tab", { name: /^Library/ }).click();
    await expect(page.getByText("secret-in-output")).toHaveCount(0);
  });

  test("a check opens in a side sheet with its YAML", async ({ page }) => {
    await open(page, "checks");
    await page.getByText("secret-in-output").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("id: secret-in-output")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Edit a copy" })).toBeVisible();
  });

  test("turning a check off and on", async ({ page }) => {
    await open(page, "checks");
    const toggle = page.getByRole("switch", { name: /secret-in-output/ });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test("the new-check editor needs a description before drafting", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Draft check" })).toBeDisabled();
    await sheet.getByRole("textbox", { name: /Describe a problem/ }).fill("The agent refunds without checking the order");
    await expect(sheet.getByRole("button", { name: "Draft check" })).toBeEnabled();
  });

  test("search narrows the table", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("textbox", { name: "Search checks" }).fill("secret");
    await expect(page.getByText("secret-in-output")).toBeVisible();
    await expect(page.getByText("runaway-loop")).toHaveCount(0);
  });

  test("pending MCP checks can be previewed, approved, or rejected", async ({ page }, testInfo) => {
    const safeYaml = "id: pending-edit\nkind: rule\naction: flag\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: 3 }\n";
    const editYaml = "id: pending-edit\nkind: rule\naction: flag\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: 1 }\n";
    const newYaml = "id: pending-new\nkind: rule\naction: flag\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: 1 }\n";
    let activeChecks = [{
      id: "pending-edit", kind: "rule", title: "Existing safe version", source: "user", path: "/checks/pending-edit.yaml", enabled: true,
      precision: { hits: 0, dismissed: 0, precision: null, noisy: false }, yaml: safeYaml,
      check: { id: "pending-edit", kind: "rule", action: "flag", rule: { type: "count", span: { type: "tool", name: "lookup_order" }, at_least: 3 } },
    }];
    let proposals = [
      { id: "pending-edit", revision: "edit-revision", kind: "rule", title: "Edited flag rule", yaml: editYaml, check: { id: "pending-edit", kind: "rule", action: "flag" }, created_ms: 2, target_dir: "/checks", has_active_version: true },
      { id: "pending-new", revision: "new-revision", kind: "rule", title: "New flag rule", yaml: newYaml, check: { id: "pending-new", kind: "rule", action: "flag" }, created_ms: 1, target_dir: null, has_active_version: false },
    ];
    await page.route("**/api/checks", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { checks: activeChecks, pending_mcp_checks: proposals, errors: [], user_dir: "~/.neatroots/checks", project_dirs: [] } });
    });
    await page.route("**/api/checks/preview", (route) => route.fulfill({ json: { checked: 2, total: 2, hits: [{ trace_id: "trace-1", probability: null, root_name: "Fixture run" }], hit_rate: 0.5, truncated: false } }));
    await page.route("**/api/checks/pending-edit/approve", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ revision: "edit-revision" });
      proposals = proposals.filter((p) => p.id !== "pending-edit");
      activeChecks = [{ ...activeChecks[0], source: "mcp", title: "Edited flag rule", yaml: editYaml, check: { ...activeChecks[0].check, action: "flag", rule: { type: "count", span: { type: "tool", name: "lookup_order" }, at_least: 1 } } }];
      await route.fulfill({ json: { ok: true, id: "pending-edit", path: "/checks/pending-edit.yaml", source: "mcp" } });
    });
    await page.route("**/api/checks/pending-new/reject", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ revision: "new-revision" });
      proposals = proposals.filter((p) => p.id !== "pending-new");
      await route.fulfill({ json: { ok: true, id: "pending-new" } });
    });

    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => localStorage.setItem("neatroots-theme", "system"));
    await open(page, "checks");
    const edit = page.getByTestId("mcp-check-proposal").filter({ hasText: "pending-edit" });
    await expect(edit.getByText("Edit · current version stays active")).toBeVisible();
    await expect(page.getByTestId("mcp-check-proposal").filter({ hasText: "pending-new" }).getByText("Inactive until approval")).toBeVisible();
    if (testInfo.repeatEachIndex === 0) {
      await page.screenshot({ path: testInfo.outputPath("mcp-approval-light.png"), fullPage: true });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: testInfo.outputPath("mcp-approval-dark.png"), fullPage: true });
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath("mcp-approval-390.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    await edit.getByRole("button", { name: "Preview check" }).click();
    await expect(edit.getByText("Fires on 1 of 2 runs")).toBeVisible();
    await edit.getByRole("button", { name: "Approve check" }).click();
    await expect(page.getByTestId("mcp-check-proposal").filter({ hasText: "pending-edit" })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "Edited flag rule" })).toBeVisible();
    await page.getByTestId("mcp-check-proposal").filter({ hasText: "pending-new" }).getByRole("button", { name: "Reject check" }).click();
    await expect(page.getByTestId("mcp-check-proposal")).toHaveCount(0);
  });

  test("saving a human-authored check from the UI still activates it immediately", async ({ page }) => {
    await open(page, "checks");
    await page.getByRole("button", { name: "New check" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("textbox", { name: "Check (YAML)" }).fill("id: ui-human-saved\nkind: rule\naction: flag\nrule: { type: count, span: { type: tool, name: lookup_order }, at_least: 3 }\n");
    await sheet.getByRole("button", { name: "Save check" }).click();
    await expect(page.getByRole("row").filter({ hasText: "ui-human-saved" })).toBeVisible();
    const response = await page.request.get(`${state().url}/api/checks`);
    const checks = await response.json();
    expect(checks.checks.some((c: { id: string }) => c.id === "ui-human-saved")).toBe(true);
    expect((checks.pending_mcp_checks ?? []).some((p: { id: string }) => p.id === "ui-human-saved")).toBe(false);
  });
});
