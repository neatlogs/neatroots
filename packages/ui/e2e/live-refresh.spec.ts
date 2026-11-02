import { expect, test, type Page } from "@playwright/test";
import { open, state } from "./util";

// Control transport timing while exercising the production hook and real query/API stack.
async function transport(page: Page) {
  await page.addInitScript(() => {
    const streams: FakeStream[] = [];
    class FakeStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) { super(); streams.push(this); }
      close() { this.closed = true; }
    }
    Object.assign(window, { EventSource: FakeStream, liveStreams: streams });
  });
}
async function signal(page: Page, kind: string, traceId?: string) {
  await page.evaluate(({ kind, traceId }) => {
    const streams = (window as unknown as { liveStreams: Array<EventTarget & { onopen: () => void; onerror: () => void }> }).liveStreams;
    const stream = streams[streams.length - 1]!;
    if (kind === "open") stream.onopen();
    else if (kind === "error") stream.onerror();
    else stream.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify({ trace_id: traceId }) }));
  }, { kind, traceId });
}
async function ingest(input: string) {
  const response = await fetch(`${state().url}/v1/trace`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "live-refresh", project: "live-refresh", input, output: "done" }),
  });
  expect(response.ok).toBeTruthy();
  return (await response.json() as { trace_id: string }).trace_id;
}

test("initial connection and reconnect recover missed runs without another event", async ({ page }) => {
  await transport(page);
  await open(page, "runs");
  await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toBeVisible();
  const initial = `initial gap ${Date.now()}`;
  await ingest(initial);
  await signal(page, "open");
  await expect(page.getByRole("cell", { name: initial })).toBeVisible();
  const connections = await page.evaluate(() => (window as unknown as { liveStreams: unknown[] }).liveStreams.length);
  await signal(page, "error");
  const missed = `reconnect gap ${Date.now()}`;
  await ingest(missed);
  await expect.poll(() => page.evaluate(() => (window as unknown as { liveStreams: unknown[] }).liveStreams.length)).toBe(connections + 1);
  await signal(page, "open");
  await expect(page.getByRole("cell", { name: missed })).toBeVisible();
});

test("sustained events refresh before the stream becomes quiet and bursts coalesce", async ({ page }) => {
  await transport(page);
  await open(page, "runs");
  await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toBeVisible();
  let requests = 0;
  page.on("request", r => { if (new URL(r.url()).pathname === "/api/runs") requests++; });
  const input = `continuous ${Date.now()}`;
  const id = await ingest(input);
  await page.evaluate(id => {
    const w = window as unknown as { liveStreams: EventTarget[]; liveInterval: number };
    w.liveInterval = window.setInterval(() => w.liveStreams[w.liveStreams.length - 1]!.dispatchEvent(new MessageEvent("trace", { data: JSON.stringify({ trace_id: id }) })), 50);
  }, id);
  await expect(page.getByRole("cell", { name: input })).toBeVisible({ timeout: 2000 });
  await page.evaluate(() => window.clearInterval((window as unknown as { liveInterval: number }).liveInterval));
  await page.waitForTimeout(400);
  requests = 0;
  await page.evaluate(id => {
    const streams = (window as unknown as { liveStreams: EventTarget[] }).liveStreams;
    const stream = streams[streams.length - 1]!;
    for (let i = 0; i < 20; i++) stream.dispatchEvent(new MessageEvent("trace", { data: JSON.stringify({ trace_id: id }) }));
  }, id);
  await expect.poll(() => requests).toBe(1);
  await page.waitForTimeout(400);
  expect(requests).toBe(1);
});

test("connection refreshes active run evidence and document teardown stops pending refresh", async ({ page }, testInfo) => {
  await transport(page);
  await open(page, `runs/${state().supportRun}`);
  await expect(page.getByRole("heading", { name: "Is order 1001 ok?" })).toBeVisible();
  let details = 0;
  page.on("request", r => { if (new URL(r.url()).pathname === `/api/runs/${state().supportRun}`) details++; });
  await signal(page, "open");
  await expect.poll(() => details).toBeGreaterThan(0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.screenshot({ path: testInfo.outputPath(`${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mobile.png") });
  await signal(page, "trace", state().supportRun);
  // A full document teardown destroys the hook and its pending timers.
  await page.goto("about:blank");
  const afterTeardown = details;
  await page.waitForTimeout(400);
  expect(details).toBe(afterTeardown);
});

for (const kind of ["list", "detail"] as const) {
  test(`${kind} connection replaces an in-flight pre-subscription snapshot`, async ({ page }) => {
    await transport(page);
    const updated = `after subscription gap ${kind} ${Date.now()}`;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let captured!: () => void;
    const snapshotCaptured = new Promise<void>(resolve => { captured = resolve; });
    let requests = 0;
    let changed = false;
    const pathname = kind === "list" ? "/api/runs" : `/api/runs/${state().supportRun}`;
    await page.route(url => url.pathname === pathname, async route => {
      const first = ++requests === 1;
      const response = await route.fetch();
      const json = await response.json();
      // Keep the real detail schema, but control the server-side version of its title.
      if (kind === "detail") json.run.input_preview = changed ? updated : "before subscription gap";
      if (first) {
        captured();
        await held;
      }
      await route.fulfill({ response, json });
    });
    await open(page, kind === "list" ? "runs" : `runs/${state().supportRun}`);
    await snapshotCaptured;
    if (kind === "list") await ingest(updated);
    changed = true;
    await signal(page, "open");
    release();
    const result = kind === "list"
      ? page.getByRole("cell", { name: updated })
      : page.getByRole("heading", { name: updated });
    await expect(result).toBeVisible();
    expect(requests).toBeGreaterThanOrEqual(2);
  });
}
