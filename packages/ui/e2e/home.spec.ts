import { expect, test } from "@playwright/test";
import { api, open } from "./util";

test.describe("home", () => {
  test("a problem link lists only runs where that check is still open", async ({ page }) => {
    const id = `home-link-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const title = `Home problem ${id}`;
    await api("/api/checks", { method: "POST", body: JSON.stringify({ id, kind: "rule", title, rule: { type: "match", span: { type: ["llm"] }, field: "output", pattern: id } }) });
    const send = (input: string) => api<{ trace_id: string }>("/v1/trace", {
      method: "POST", body: JSON.stringify({ name: "support", project: id, input, children: [{ name: "answer", kind: "LLM", model: "mock", input: [{ role: "user", content: input }], output: id }] }),
    });
    const resolved = await send(`Resolved ${id}`);
    const raised = await send(`Open ${id}`);
    for (const run of [resolved, raised]) {
      await expect.poll(async () => (await api<{ coverage: { state: string } }>(`/api/runs/${run.trace_id}`)).coverage.state).not.toBe("checking");
    }
    const findings = await api<{ findings: { id: string }[] }>(`/api/findings?trace_id=${resolved.trace_id}&check_id=${id}`);
    expect(findings.findings).toHaveLength(1);
    await api(`/api/findings/${findings.findings[0].id}`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
    await open(page, "home");
    const link = page.getByRole("link").filter({ hasText: title });
    await expect(link).toContainText(/in 1 of/);
    await link.click();
    await expect(page.getByRole("cell", { name: `Open ${id}`, exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: `Resolved ${id}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "With problems", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(page.getByRole("cell", { name: `Open ${id}`, exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: `Resolved ${id}`, exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Resolved ${id}`, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("cell", { name: `Resolved ${id}`, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "With problems", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: "With problems", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("cell", { name: `Resolved ${id}`, exact: true })).toHaveCount(0);
  });

  test("shows the period's numbers and what needs attention", async ({ page }) => {
    await open(page, "home");
    await expect(page.getByText("Runs", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Runs with problems")).toBeVisible();
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.getByText("Working well")).toBeVisible();
  });

  test("the setup guide checks steps against what is set up", async ({ page }) => {
    await open(page, "home");
    // Collapsed once the essentials are set up, expanded otherwise; wait for either.
    const show = page.getByRole("button", { name: "Show setup steps" });
    await expect(show.or(page.getByText("How to use neatroots"))).toBeVisible();
    if (await show.isVisible()) await show.click();
    await expect(page.getByText("How to use neatroots")).toBeVisible();
    await expect(page.getByText("Send your agent's runs to neatroots")).toBeVisible();
  });

  test("switching the period keeps the page working", async ({ page }) => {
    await open(page, "home");
    await page.getByRole("tab", { name: "24 hours" }).click();
    await expect(page.getByText("Runs with problems")).toBeVisible();
    await page.getByRole("tab", { name: "30 days" }).click();
    await expect(page.getByText("Runs with problems")).toBeVisible();
  });
});
