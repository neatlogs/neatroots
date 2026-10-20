import { expect, test } from "@playwright/test";
import { open, state } from "./util";

for (const attribution of ["explicit", "fallback-unverified", "unknown", "ambiguous"] as const) {
  test(`replay navigation discloses ${attribution} attribution`, async ({ page }, testInfo) => {
    const original = state().researchRun;
    const target = state().supportRun;
    const reason = attribution === "fallback-unverified"
      ? "Run selected by timing after the full wait; replay identity is unverified."
      : attribution === "ambiguous" ? "Replay IDs are duplicated or contradictory; the run association was revoked."
        : attribution === "unknown" ? "Replay association predates attribution evidence." : "Unique explicit replay ID.";
    const replay = { id: "rp_112233445566", trace_id: original, span_id: null, kind: "run", via: "http", overrides: {},
      state: "succeeded", new_trace_id: attribution === "ambiguous" ? null : target, output_preview: "example result",
      attribution, attribution_reason: reason, error: null, log_tail: null, created_ms: Date.now(), finished_ms: Date.now() };
    await page.route(new RegExp(`/api/runs/(${original}|${target})$`), async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (route.request().url().endsWith(original)) data.replays = [replay];
      else data.replay_of = replay.new_trace_id ? replay : null;
      await route.fulfill({ response, json: data });
    });
    await open(page, `runs/${original}`);
    const panel = page.getByTestId("replays");
    await expect(panel.getByText("Finished", { exact: true })).toBeVisible();
    if (attribution === "explicit") await expect(panel.getByTestId("replay-attribution")).toHaveCount(0);
    else await expect(panel.getByTestId("replay-attribution")).toContainText("Unverified identity");
    if (attribution === "fallback-unverified") {
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
        await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
        await page.screenshot({ path: testInfo.outputPath(`replay-${theme}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath("replay-390.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    const link = panel.locator("a");
    if (attribution === "ambiguous") await expect(link).not.toHaveAttribute("href");
    else {
      await expect(link).toHaveAttribute("href", `#/runs/${target}`);
      await open(page, `runs/${target}`);
      if (attribution === "explicit") await expect(page.getByTestId("replay-origin-attribution")).toHaveCount(0);
      else await expect(page.getByTestId("replay-origin-attribution")).toContainText("identity is unverified");
    }
  });
}

test("a late conflict event removes cached replay navigation and the old destination banner", async ({ context, page }) => {
  const original = state().researchRun, target = state().supportRun;
  let revoked = false;
  const replay = { id: "rp_112233445566", trace_id: original, span_id: null, kind: "run", via: "http", overrides: {},
    state: "succeeded", new_trace_id: target, output_preview: "example result", attribution: "explicit",
    attribution_reason: "Unique explicit replay ID.", error: null, log_tail: null, created_ms: Date.now(), finished_ms: Date.now() };
  // Deliver a replay event to the actual EventSource instance: production subscription,
  // debounce, query invalidation and rendered REST refetch all run unchanged.
  await context.addInitScript(() => {
    const Native = window.EventSource;
    const sources: EventSource[] = [];
    Object.assign(window, { replayEventSources: sources });
    window.EventSource = class extends Native {
      constructor(url: string | URL, config?: EventSourceInit) { super(url, config); sources.push(this); }
    };
  });
  await context.route(new RegExp(`/api/runs/(${original}|${target})$`), async (route) => {
    const response = await route.fetch(), data = await response.json();
    const current = revoked ? { ...replay, new_trace_id: null, output_preview: null, attribution: "ambiguous",
      attribution_reason: "Replay IDs are duplicated or contradictory; the run association was revoked." } : replay;
    if (route.request().url().endsWith(original)) data.replays = [current];
    else data.replay_of = revoked ? null : current;
    await route.fulfill({ response, json: data });
  });
  await open(page, `runs/${original}`);
  await expect(page.getByTestId("replays").locator("a")).toHaveAttribute("href", `#/runs/${target}`);
  const destination = await context.newPage();
  await open(destination, `runs/${target}`);
  await expect(destination.getByText("Replay of", { exact: false })).toBeVisible();
  revoked = true;
  for (const view of [page, destination]) await view.evaluate((event) => {
    for (const source of (window as unknown as { replayEventSources: EventSource[] }).replayEventSources)
      source.dispatchEvent(new MessageEvent("replay", { data: JSON.stringify(event) }));
  }, { id: replay.id, trace_id: original, previous_trace_id: target, new_trace_id: null, attribution: "ambiguous" });
  await expect(page.getByTestId("replays").locator("a")).not.toHaveAttribute("href");
  await expect(page.getByTestId("replay-attribution")).toContainText("Unverified identity");
  await expect(destination.getByText("Replay of", { exact: false })).toHaveCount(0);
});
