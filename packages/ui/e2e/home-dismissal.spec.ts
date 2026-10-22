import { expect, test, type Page } from "@playwright/test";
import type { Insights } from "../src/lib/api";
import { api, open, state, watchErrors } from "./util";

type Target = { finding_id: string; check_id: string; project: string };

/** Isolated API fixtures: no shared seed finding is mutated, including on repeated runs. */
async function fixture(page: Page) {
  const data = await api<Insights>("/api/insights?window=7d");
  data.quiet_after = 3;
  data.totals.runs = 4;
  data.digest = { window: "7d", insights: [], model: "mock", where: "local", created_ms: Date.now(), runs: 4 };
  data.digest_pending = false;
  data.problems = [{ check_id: "noise", title: "Repeated warning", kind: "rule", runs: 3, prev_runs: 0, dismissed: 1, last_ms: Date.now(), example_trace_id: "example", projects: ["alpha", "beta"],
    dismissal_projects: [
      { project: "alpha", name: "alpha", runs: 2, dismissed: 1, newest_finding_id: "alpha-newest" },
      { project: "beta", name: "beta", runs: 1, dismissed: 0, newest_finding_id: "beta-newest" },
    ] }];
  await page.route(/\/api\/insights\?/, (route) => route.fulfill({ json: data }));
  return data;
}

function row(page: Page, project: string) {
  return page.getByTestId("home-problem").filter({ has: page.getByRole("button", { name: `Dismiss finding for Repeated warning in ${project}`, exact: true }) });
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`dismisses only the named project's newest finding, ${theme} ${width}px`, async ({ page }, info) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript((theme) => localStorage.setItem("neatroots-theme", theme), theme);
      const data = await fixture(page);
      const alpha = data.problems[0].dismissal_projects![0];
      const requests: Target[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/insights/dismiss", async (route) => {
        const target = route.request().postDataJSON() as Target;
        requests.push(target);
        if (requests.length === 1) await held;
        alpha.dismissed++;
        alpha.newest_finding_id = requests.length === 1 ? "alpha-older" : null;
        // Real aggregation removes the project after its last qualifying finding.
        if (requests.length === 2) data.problems[0].dismissal_projects = data.problems[0].dismissal_projects!.filter(p => p.project !== "alpha");
        await route.fulfill({ json: { ok: true, finding_id: target.finding_id, dismissed: alpha.dismissed } });
      });
      // The generic open helper waits for a desktop-only sidebar link.
      await page.goto(`${state().url}/#/home`);
      await expect(row(page, "alpha")).toBeVisible();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      await expect(row(page, "alpha")).toContainText("1 of 3 dismissals until this check goes quiet here");
      await expect(row(page, "beta")).toContainText("0 of 3 dismissals");
      await expect(row(page, "alpha").getByRole("link")).toHaveAttribute("href", /&project=alpha$/);
      // Problem rows keep the fixed height of Home's other rows.
      expect(await row(page, "alpha").evaluate((e) => e.getBoundingClientRect().height)).toBe(56);
      // The panel fits the viewport, so the button isn't clipped off a phone's screen.
      expect(await row(page, "alpha").getByRole("button").evaluate((e) => e.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
      await row(page, "alpha").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`home-${theme}-${width}-before.png`), fullPage: true });
      const button = row(page, "alpha").getByRole("button");
      await button.click();
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
      await expect.poll(() => requests.length).toBe(1);
      expect(requests).toEqual([{ finding_id: "alpha-newest", check_id: "noise", project: "alpha" }]);
      release();
      await expect(row(page, "alpha")).toContainText("2 of 3 dismissals");
      await expect(button).toBeEnabled();
      await button.click();
      await expect(row(page, "alpha")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Dismissed finding for Repeated warning in alpha." }).first()).toBeVisible();
      await expect(row(page, "beta")).toContainText("0 of 3 dismissals");
      expect(requests).toEqual([
        { finding_id: "alpha-newest", check_id: "noise", project: "alpha" },
        { finding_id: "alpha-older", check_id: "noise", project: "alpha" },
      ]);
      await page.screenshot({ path: info.outputPath(`home-${theme}-${width}-after.png`), fullPage: true });
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("shows a stale-target error, refreshes identity, and requires a new click", async ({ page }) => {
  const data = await fixture(page);
  const alpha = data.problems[0].dismissal_projects![0];
  const requests: Target[] = [];
  await page.route("**/api/insights/dismiss", async (route) => {
    const target = route.request().postDataJSON() as Target;
    requests.push(target);
    if (requests.length === 1) {
      alpha.newest_finding_id = "alpha-arrived-later";
      await route.fulfill({ status: 409, json: { error: "The newest open finding changed. Review the refreshed Home row and try again." } });
    } else {
      alpha.dismissed++;
      alpha.newest_finding_id = null;
      await route.fulfill({ json: { ok: true, finding_id: target.finding_id, dismissed: alpha.dismissed } });
    }
  });
  await open(page, "home");
  await row(page, "alpha").getByRole("button").click();
  await expect(row(page, "alpha").getByRole("alert")).toContainText("Review the refreshed Home row and try again.");
  // The error takes the detail line; the progress stays in the row link's title.
  await expect(row(page, "alpha").getByRole("link")).toHaveAttribute("title", /1 of 3 dismissals/);
  expect(requests).toHaveLength(1);
  await row(page, "alpha").getByRole("button").click();
  await expect(row(page, "alpha")).toContainText("2 of 3 dismissals");
  expect(requests[1]).toEqual({ finding_id: "alpha-arrived-later", check_id: "noise", project: "alpha" });
});

test("keeps failures actionable and handles no open findings and empty problem lists", async ({ page }) => {
  const data = await fixture(page);
  data.problems[0].dismissal_projects![1].newest_finding_id = null;
  let requests = 0;
  await page.route("**/api/insights/dismiss", async (route) => {
    requests++;
    await route.fulfill({ status: 503, json: { error: "Local store temporarily unavailable" } });
  });
  await open(page, "home");
  await expect(row(page, "beta").getByRole("button")).toBeDisabled();
  await row(page, "alpha").getByRole("button").click();
  await expect(row(page, "alpha").getByRole("alert")).toHaveText("Could not dismiss this finding. Review the refreshed Home row and try again.");
  await expect(row(page, "alpha").getByRole("button")).toBeEnabled();
  await expect(row(page, "alpha").getByRole("link")).toHaveAttribute("title", /1 of 3 dismissals/);
  expect(requests).toBe(1);
  data.problems = [];
  await page.reload();
  await expect(page.getByTestId("home-problem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Dismiss finding for/ })).toHaveCount(0);
});


test("preserves actionable error feedback when the target disappears during refresh", async ({ page }) => {
  const data = await fixture(page);
  let requests = 0;
  await page.route("**/api/insights/dismiss", async route => {
    requests++;
    data.problems = [];
    await route.fulfill({ status: 409, json: { error: "PRIVATE server detail must not appear in persistent feedback" } });
  });
  await open(page, "home");
  await row(page, "alpha").getByRole("button").click();
  await expect(page.getByTestId("home-problem")).toHaveCount(0);
  const feedback = page.locator("[data-sonner-toast]").filter({ hasText: "Could not dismiss finding for Repeated warning in alpha." });
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("Review the refreshed Home row and try again.");
  await expect(feedback).not.toContainText("PRIVATE");
  expect(requests).toBe(1);
});


for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`keeps mounted-row server errors private, ${theme} ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(theme => localStorage.setItem("neatroots-theme", theme), theme);
      await fixture(page);
      let requests = 0;
      const privateMarker = "PRIVATE_SERVER_ERROR_7f9e";
      await page.route("**/api/insights/dismiss", async route => {
        requests++;
        await route.fulfill({ status: 503, json: { error: privateMarker } });
      });
      await page.goto(`${state().url}/#/home`);
      const alpha = row(page, "alpha");
      await alpha.getByRole("button").click();
      await expect(alpha.getByRole("alert")).toHaveText("Could not dismiss this finding. Review the refreshed Home row and try again.");
      await expect(alpha.getByRole("button")).toBeEnabled();
      await expect(page.locator("body")).not.toContainText(privateMarker);
      await expect(alpha.getByRole("link")).toHaveAttribute("title", /1 of 3 dismissals/);
      expect(requests).toBe(1);
      await alpha.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`safe-error-${theme}-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
