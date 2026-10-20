import { expect, test } from "@playwright/test";
import { api, open } from "./util";

test("real run API explanations match the scrollable panel across themes and mobile", async ({ page }, testInfo) => {
  const created = await api<{ trace_id: string }>("/v1/trace", { method: "POST", body: JSON.stringify({
    name: "explanation-e2e", project: "explanation-e2e", input: "Say hello", output: "Hello",
    children: [{ name: "respond", kind: "LLM", input: [{ role: "user", content: "Say hello" }], output: "Hello" }],
  }) });
  type Detail = { check_outcomes: { generation: string; checks: { check_id: string; title: string; counts: Record<string, number> }[] } | null };
  await expect.poll(async () => (await api<Detail>(`/api/runs/${created.trace_id}`)).check_outcomes?.checks.length ?? 0).toBeGreaterThan(0);
  const before = (await api<Detail>(`/api/runs/${created.trace_id}`)).check_outcomes!;
  await api(`/api/runs/${created.trace_id}/recheck`, { method: "POST", body: "{}" });
  await expect.poll(async () => (await api<Detail>(`/api/runs/${created.trace_id}`)).check_outcomes?.generation).not.toBe(before.generation);
  await open(page, `runs/${created.trace_id}`);
  const panel = page.getByTestId("check-outcomes-panel");
  await expect(panel).toContainText("Counts are observations");
  const current = (await api<Detail>(`/api/runs/${created.trace_id}`)).check_outcomes!;
  await expect(panel).toContainText(current.generation.slice(0, 8));
  await expect(panel).toContainText(current.checks[0].title);
  await panel.locator("summary").first().click();
  await expect(panel).toContainText(/Rule result unknown|Rule evaluated clear|Flag raised|Evaluation started|Queued|Waiting for run end/);
  const scroll = panel.getByLabel("Check explanations");
  expect(await scroll.evaluate((element) => ({ height: element.clientHeight, overflow: getComputedStyle(element).overflowY }))).toEqual({ height: 256, overflow: "auto" });
  for (const mode of ["light", "dark", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "mobile" ? 390 : 1440, height: 960 });
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), mode === "dark");
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`check-explanations-${mode}.png`), fullPage: true });
  }
});
