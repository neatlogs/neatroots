import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, open } from "./util";

const project = "coverage-e2e";
function trace(id: string) {
  const now = BigInt(Date.now()) * 1000000n;
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: project } }] }, scopeSpans: [{ scope: { name: "coverage-test" }, spans: [{ traceId: id, spanId: randomBytes(8).toString("hex"), name: "coverage example", startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1000000n), attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "workflow" } }], status: { code: 1 } }] }] }] };
}

test.describe("audit", () => {
  test("capture evidence stays separate from editable archive protection", async ({ page }, info) => {
    const prior = await api<any>("/api/status");
    const priorCoverage = await api<any>("/api/audit/status");
    const override = priorCoverage.coverage.projects.find((p: any) => p.project === project)?.audit_override ?? null;
    const ids = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ project, audit: false, audit_enabled: false }) });
      await api("/v1/traces", { method: "POST", body: JSON.stringify(trace(ids[0])) });
      await api("/api/imports/file", { method: "POST", body: JSON.stringify({ name: "coverage.json", content: JSON.stringify(trace(ids[1])) }) });
      await api("/api/settings", { method: "POST", body: JSON.stringify({ project, audit: null }) });
      await open(page, "settings/audit");
      await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible();
      await expect(page.getByText("Capture evidence", { exact: true }).first()).toBeVisible();
      const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: project, exact: true }) });
      await expect(row).toContainText("1 received · 1 imported · 0 unknown");
      await page.getByRole("switch", { name: "Default protection for projects" }).click();
      await page.getByRole("button", { name: "Save protection", exact: true }).first().click();
      await expect(page.getByText("Audit protection saved", { exact: true })).toBeVisible();
      for (const [label, value] of [["On", true], ["Off", false], ["Inherit", null]] as const) {
        await row.getByRole("combobox", { name: `Protection for ${project}` }).click();
        await page.getByRole("option", { name: label, exact: true }).click();
        await row.getByRole("button", { name: "Save protection", exact: true }).click();
        await expect.poll(async () => (await api<any>("/api/audit/status")).coverage.projects.find((p: any) => p.project === project).audit_override).toBe(value);
      }
      await expect(row).toContainText("Effective protection: on");
      await row.scrollIntoViewIfNeeded();
      await expect(page.getByText("1 received · 1 imported · 0 unknown", { exact: true })).toBeVisible();
      for (const [name, width, scheme] of [["light", 1440, "light"], ["dark", 1440, "dark"], ["mobile", 390, "light"]] as const) {
        await page.setViewportSize({ width, height: 960 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate(mode => { document.documentElement.classList.toggle("dark", mode === "dark"); }, scheme);
        await page.getByText("Capture evidence", { exact: true }).first().scrollIntoViewIfNeeded();
        await page.screenshot({ animations: "disabled", path: info.outputPath(`audit-${name}.png`) });
        await page.getByText("MCP connections", { exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByText(/An MCP connection reads neatroots over MCP/)).toBeVisible();
        await page.screenshot({ animations: "disabled", path: info.outputPath(`audit-${name}-connections.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    } finally {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ project, audit: false, audit_enabled: false }) });
      for (const id of ids) await api(`/api/runs/${id}`, { method: "DELETE" });
      await api("/api/settings", { method: "POST", body: JSON.stringify({ project, audit: override, audit_enabled: prior.config.audit.enabled, audit_directory: prior.config.audit.directory }) });
    }
  });

  test("failed settings save preserves edits and reports the error", async ({ page }) => {
    await open(page, "settings/audit");
    await expect(page.getByRole("textbox", { name: "Archive directory" })).toBeVisible();
    await page.route("**/api/settings", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "test write failure" }) }));
    await page.getByRole("textbox", { name: "Archive directory" }).fill("/save-failure-must-not-write");
    await page.getByRole("button", { name: "Save protection", exact: true }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: "Your edits are preserved" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Archive directory" })).toHaveValue("/save-failure-must-not-write");
    const row = page.getByRole("row").filter({ has: page.getByRole("combobox") }).first();
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: "Off", exact: true }).click();
    await row.getByRole("button", { name: "Save protection", exact: true }).click();
    await expect(row.getByRole("alert")).toContainText("selection kept");
    await expect(row.getByRole("combobox")).toContainText("Off");
  });

  test("older or unavailable coverage has a safe retry", async ({ page }) => {
    await page.route("**/api/audit/status", route => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await open(page, "settings/audit");
    await expect(page.getByText("Audit status unavailable", { exact: true })).toBeVisible();
    await page.unroute("**/api/audit/status");
    await page.getByRole("button", { name: "Retry audit status" }).click();
    await expect(page.getByText("Capture evidence", { exact: true }).first()).toBeVisible();
  });

  test("unassigned and literal no-project rows keep distinct controls", async ({ page }) => {
    const data = await api<any>("/api/audit/status");
    const count = { traced: 1, imported: 0, unclassified: 0, guidance_delivered: 0, audit_enabled: false, audit_override: null };
    data.coverage.projects = [{ project: null, ...count }, { project: "no-project", ...count }];
    await page.route("**/api/audit/status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) }));
    const errors: string[] = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await open(page, "settings/audit");
    const unassigned = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "No project", exact: true }) });
    const named = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "no-project", exact: true }) });
    await expect(unassigned).toContainText("Exempt");
    await expect(unassigned.getByRole("combobox")).toHaveCount(0);
    await expect(named.getByRole("combobox")).toHaveCount(1);
    expect(errors.filter(e => /same key|unique.*key/i.test(e))).toEqual([]);
  });

  test("empty capture and unavailable discovery do not imply full coverage", async ({ page }) => {
    const data = await api<any>("/api/audit/status");
    data.failures = [{ trace_id: "fixture", error: "permission failure" }];
    data.coverage = { ...data.coverage, observed_runs: 0, traced_runs: 0, imported_runs: 0, unclassified_runs: 0, guidance_delivered_runs: 0, projects: [], connections: { state: "unavailable", checked_ms: Date.now(), clients: [] } };
    await page.route("**/api/audit/status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) }));
    await open(page, "settings/audit");
    await expect(page.getByText(/No retained run evidence yet/)).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Archive write or verification failed");
    await page.getByText("MCP connections", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText(/Connection inventory unavailable. Stored-run counts remain available/)).toBeVisible();
  });
});
