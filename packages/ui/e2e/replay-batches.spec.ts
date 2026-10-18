import http from "node:http";
import { expect, test } from "@playwright/test";
import { api, open, state, watchErrors } from "./util";

async function setup(delay = 0) {
  const project = `e2e-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let calls = 0;
  const send = (attributes = {}) => api<{ trace_id: string }>("/v1/trace", {
    method: "POST", body: JSON.stringify({ name: "batch-test", project, input: "Repeat this local task", output: "Done", attributes,
      children: Array.from({ length: 3 }, () => ({ name: "lookup", tool_name: "lookup", input: "same", output: "same" })),
    }),
  });
  const original = await send();
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls++;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await send({ "neatroots.replay.id": JSON.parse(text).replay_id });
    res.end("done");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await api(`/api/projects/${project}/rerun`, { method: "POST", body: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/run` }) });
  return { trace: original.trace_id, calls: () => calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("validates Repeat count, runs a batch, and renders honest frequency in light, dark and narrow views", async ({ page }, info) => {
  const fixture = await setup();
  try {
    const errors = watchErrors(page);
    await open(page, `runs/${fixture.trace}`);
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const repeat = dialog.getByRole("spinbutton", { name: "Repeat count" });
    await repeat.fill("21");
    await expect(dialog.getByRole("button", { name: "Re-run agent", exact: true })).toBeDisabled();
    await repeat.fill("2");
    await dialog.getByRole("button", { name: "Re-run agent", exact: true }).click();
    const panel = page.getByTestId("replay-batches");
    await expect(panel.getByText("2 repeats · completed")).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByText(/2\/2 linked · 2 checked/)).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByRole("table", { name: "Finding frequency" })).toBeVisible();
    await expect(panel.getByRole("row").filter({ hasText: "repeated-tool-call" })).toContainText("2/2");
    await expect(panel.getByRole("row").filter({ hasText: "repeated-tool-call" })).toContainText("Yes");
    expect(fixture.calls()).toBe(2);
    for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 390]] as const) {
      await page.evaluate((value) => { localStorage.setItem("neatroots-theme", value); document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
      await page.setViewportSize({ width, height: 960 });
      await panel.scrollIntoViewIfNeeded();
      await expect(panel).toBeVisible();
      await page.screenshot({ path: info.outputPath(`batch-${theme}-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test("cancels remaining repeats and discloses active work", async ({ page }) => {
  const fixture = await setup(2500);
  try {
    await open(page, `runs/${fixture.trace}`);
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Repeat count" }).fill("20");
    await page.getByRole("button", { name: "Re-run agent", exact: true }).click();
    const panel = page.getByTestId("replay-batches");
    await panel.getByRole("button", { name: "Cancel remaining repeats" }).click();
    await expect(panel.getByText(/20 repeats · (cancelling|cancelled)/)).toBeVisible();
    await expect(panel.getByText("20 repeats · cancelled")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(/19 cancelled/)).toBeVisible();
    expect(fixture.calls()).toBe(1);
  } finally { await fixture.close(); }
});

test("refreshes batch results immediately after replay without interval polling", async ({ page }) => {
  const fixture = await setup();
  let created = false, reads = 0;
  const result = { id: "rb_immediate", times: 2, state: "completed", linked: 2, settled: 2, clean: 2,
    pending: 0, failed: 0, execution_failed: 0, evaluation_failed: 0, unlinked: 0, cancelled: 0, error: null, findings: [] };
  try {
    await page.clock.install();
    await page.route(`**/api/runs/${fixture.trace}/replay-batches`, async route => {
      reads++;
      await route.fulfill({ json: created ? [result] : [] });
    });
    await page.route(`**/api/runs/${fixture.trace}/replay`, async route => {
      created = true; await route.fulfill({ json: result });
    });
    await open(page, `runs/${fixture.trace}`);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Repeat count" }).fill("2");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.clock.runFor(1500); // Complete one poll; the next interval is 1500ms away.
    const before = reads;
    const response = page.waitForResponse(r => r.url().endsWith(`/api/runs/${fixture.trace}/replay`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Re-run agent", exact: true }).click();
    await response;
    await page.clock.runFor(200); // Notifications may run; the next poll cannot.
    await expect(page.getByTestId("replay-batches").getByText("2 repeats · completed")).toBeVisible();
    expect(reads).toBeGreaterThan(before);
  } finally { await fixture.close(); }
});
