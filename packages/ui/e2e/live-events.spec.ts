import { expect, test as base } from "@playwright/test";
import { liveEventsServer } from "./fixtures/live-events-server";

const test = base.extend<{ live: Awaited<ReturnType<typeof liveEventsServer>> }>({
  live: async ({}, use) => {
    const server = await liveEventsServer();
    try { await use(server); } finally { await server.close(); }
  },
});

test("initial SSE connection reconciles updates missed after the first query", async ({ page, live }) => {
  live.pause();
  await page.goto(live.url);
  await expect(page.getByTestId("list")).toContainText("original-a");
  await expect(page.getByTestId("a")).toContainText("original-a");
  await expect(page.getByTestId("connected")).toHaveText("false");
  live.values.a = "missed-before-open";
  live.resume();
  await expect(page.getByTestId("connected")).toHaveText("true");
  for (const view of ["list", "a", "chat", "conversation", "replay"]) {
    await expect(page.getByTestId(view)).toContainText("missed-before-open");
  }
});

test("SSE reconnect refreshes active run views without refreshing unrelated evidence", async ({ page, live }) => {
  await page.goto(live.url);
  await expect(page.getByTestId("connected")).toHaveText("true");
  for (const view of ["a", "span", "evidence"]) await expect(page.getByTestId(view)).toContainText("original-a");
  await expect.poll(() => live.count("/api/runs/inactive")).toBe(1);
  const spanReads = live.count("/api/runs/a/spans/span");
  const evidenceReads = live.count("/api/evidence");
  live.pause();
  await expect(page.getByTestId("connected")).toHaveText("false");
  live.values.a = "missed-a";
  live.values.b = "missed-b";
  live.resume();
  await expect(page.getByTestId("connected")).toHaveText("true");
  for (const view of ["list", "a", "chat", "conversation", "replay"]) {
    await expect(page.getByTestId(view)).toContainText("missed-a");
  }
  await expect(page.getByTestId("b")).toContainText("missed-b");
  expect(live.count("/api/runs/a/spans/span")).toBe(spanReads);
  expect(live.count("/api/evidence")).toBe(evidenceReads);
  expect(live.count("/api/runs/inactive")).toBe(1);
});

test("continuous events flush every batch, retain all trace IDs, and stop refreshing when idle", async ({ page, live }) => {
  await page.goto(live.url);
  await expect(page.getByTestId("connected")).toHaveText("true");
  await expect(page.getByTestId("b")).toContainText("original-b");
  const before = live.count("/api/runs");
  live.values.a = "continuous-a";
  live.values.b = "batched-b";
  live.emit("b");
  let events = 1;
  const producer = setInterval(() => { events++; live.emit("a"); }, 50);
  try {
    await expect(page.getByTestId("a")).toContainText("continuous-a", { timeout: 5000 });
    await expect(page.getByTestId("b")).toContainText("batched-b");
    await expect.poll(() => live.count("/api/runs") - before).toBeGreaterThanOrEqual(3);
    // Several flushes while events are still arriving, with fewer requests than events.
    expect(live.count("/api/runs") - before).toBeLessThan(events / 2);
  } finally { clearInterval(producer); }
  live.values.a = "final-a";
  live.emit("a");
  await expect(page.getByTestId("a")).toContainText("final-a");
  const settled = live.count("/api/runs");
  await page.waitForTimeout(650);
  expect(live.count("/api/runs")).toBe(settled);
});

test("effect cleanup clears the timer and pending trace IDs before restarting", async ({ page, live }) => {
  await page.goto(live.url);
  await expect(page.getByTestId("connected")).toHaveText("true");
  await expect(page.getByTestId("b")).toContainText("original-b");
  live.emit("b");
  await expect(page.getByTestId("span-tick")).toHaveText("1");
  live.pause();
  await expect(page.getByTestId("connected")).toHaveText("false");
  const attempts = live.attempts;
  await page.evaluate(() => document.getElementById("replace")!.click());
  await expect.poll(() => live.attempts).toBe(attempts + 1);
  live.resume();
  await expect(page.getByTestId("connected")).toHaveText("true");
  await expect(page.getByTestId("b")).toContainText("original-b");
  const before = live.count("/api/runs/b");
  live.values.a = "after-effect-restart";
  live.values.b = "must-not-refetch";
  live.emit("a");
  await expect(page.getByTestId("a")).toContainText("after-effect-restart");
  expect(live.count("/api/runs/b")).toBe(before);
  await expect(page.getByTestId("b")).toContainText("original-b");
});

test("unmount cancels pending refreshes and reconnect attempts", async ({ page, live }) => {
  await page.goto(live.url);
  await expect(page.getByTestId("connected")).toHaveText("true");
  await expect(page.getByTestId("a")).toContainText("original-a");
  const before = live.count("/api/runs/a");
  live.values.a = "must-not-refresh";
  live.emit("a");
  await expect(page.getByTestId("span-tick")).toHaveText("1");
  await page.evaluate(() => document.getElementById("stop")!.click());
  await expect.poll(() => live.connections).toBe(0);
  await page.waitForTimeout(450);
  expect(live.count("/api/runs/a")).toBe(before);
  await page.evaluate(() => document.getElementById("start")!.click());
  await expect(page.getByTestId("connected")).toHaveText("true");
  live.pause();
  await expect(page.getByTestId("connected")).toHaveText("false");
  await page.evaluate(() => document.getElementById("stop")!.click());
  const attempts = live.attempts;
  await page.waitForTimeout(2200);
  expect(live.attempts).toBe(attempts);
});
