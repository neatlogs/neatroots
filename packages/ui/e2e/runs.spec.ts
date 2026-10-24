import { expect, test } from "@playwright/test";
import { api, open, state } from "./util";

test.describe("runs list", () => {
  test("lists the seeded runs with their problems", async ({ page }) => {
    await open(page, "runs");
    await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Write a note on solar batteries" })).toBeVisible();
    await expect(page.getByText(/secret key/i).first()).toBeVisible();
  });

  test("filters by status and by search text", async ({ page }) => {
    await open(page, "runs");
    await page.getByRole("tab", { name: "Failed" }).click();
    await expect(page.getByRole("cell", { name: /Refund invoice 77/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toHaveCount(0);
    await page.getByRole("tab", { name: "All" }).click();
    await page.getByRole("textbox", { name: /Search/ }).fill("solar");
    await expect(page.getByRole("cell", { name: "Write a note on solar batteries" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toHaveCount(0);
  });

  test("opens a run from the table", async ({ page }) => {
    await open(page, "runs");
    await page.getByRole("cell", { name: "Is order 1001 ok?" }).click();
    await expect(page).toHaveURL(new RegExp(`#/runs/(${state().supportRun}|${state().secondTurn})|#/runs/[0-9a-f]{32}`));
    await expect(page.getByRole("heading", { name: "Is order 1001 ok?" })).toBeVisible();
  });

  test("With problems excludes resolved-only runs while has_finding keeps them", async ({ page }) => {
    const project = `e2e-open-findings-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const send = (input: string) => api<{ trace_id: string }>("/v1/trace", {
      method: "POST",
      body: JSON.stringify({ name: "support", project, input, children: [{ name: "answer", kind: "LLM", model: "mock", input: [{ role: "user", content: input }], output: "Our payments key is sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c." }] }),
    });
    const resolved = await send("Resolved finding request");
    const raised = await send("Open finding request");
    const findings = (id: string) => api<{ findings: { id: string }[] }>(`/api/findings?trace_id=${id}`);
    await expect.poll(async () => (await findings(resolved.trace_id)).findings.length).toBeGreaterThan(0);
    await expect.poll(async () => (await findings(raised.trace_id)).findings.length).toBeGreaterThan(0);
    for (const id of [resolved.trace_id, raised.trace_id]) {
      await expect.poll(async () => (await api<{ coverage: { state: string } }>(`/api/runs/${id}`)).coverage.state).not.toBe("checking");
    }
    for (const finding of (await findings(resolved.trace_id)).findings) {
      await api(`/api/findings/${finding.id}`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
    }
    const all = await api<{ runs: { trace_id: string }[] }>(`/api/runs?project=${project}&has_finding=1`);
    expect(all.runs.map((run) => run.trace_id).sort()).toEqual([resolved.trace_id, raised.trace_id].sort());
    await open(page, `runs?project=${project}`);
    await expect(page.getByRole("cell", { name: "Resolved finding request", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Open finding request", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "With problems", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Resolved finding request", exact: true })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Open finding request", exact: true })).toBeVisible();
  });

  test("a new run shows up live without reloading", async ({ page }) => {
    await open(page, "runs");
    const input = `a run that arrives while you watch ${Date.now()}`;
    await fetch(`${state().url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live", project: "e2e-live", input }) });
    await expect(page.getByRole("cell", { name: input })).toBeVisible();
  });
});

// Runs made inside a test, in a project of their own, so repeats don't see each other's. They are
// dated 2020 so they sort after the seeded runs other tests look for on the first page.
async function sendRuns(project: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 25) {
    const batch = Array.from({ length: Math.min(25, n - i) }, (_, k) =>
      fetch(`${state().url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "step", project, input: `request ${i + k}`, output: "done", start: new Date(Date.UTC(2020, 0, 1) + (i + k) * 1000).toISOString(), duration_ms: 5 }) }).then((r) => r.json() as Promise<{ trace_id: string }>),
    );
    for (const r of await Promise.all(batch)) ids.push(r.trace_id);
  }
  return ids;
}

test.describe("runs list beyond one page", () => {
  test("Load more runs reaches runs past the first 150", async ({ page }) => {
    const project = `e2e-many-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await sendRuns(project, 155);
    await open(page, `runs?project=${project}`);
    await expect(page.getByText(/^155 matching of \d+ runs, newest 150 shown$/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Load more runs" }).click();
    await expect(page.getByText(/^155 matching of \d+ runs$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more runs" })).toBeHidden();
  });
});

test.describe("deleting a run", () => {
  test("Delete run asks first, then removes it and goes back to the list", async ({ page }) => {
    const [id] = await sendRuns(`e2e-delete-${Date.now()}`, 1);
    await open(page, `runs/${id}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Delete this run?")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete run" }).click();
    await expect(page).toHaveURL(/#\/runs$/);
    expect((await fetch(`${state().url}/api/runs/${id}`)).status).toBe(404);
  });
});
