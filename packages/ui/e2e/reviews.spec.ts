import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, open, watchErrors } from "./util";

/** Seeds a unique project with two rule findings, independent of other tests. */
async function seedReviewRun() {
  const project = `refund-review-${randomUUID().slice(0, 8)}`;
  const lookup = { name: "lookup_order", kind: "TOOL", tool_name: "lookup_order", input: { order_id: "4512" }, status: "ERROR", error: "404: order 4512 not found", duration_ms: 30 };
  const { trace_id } = await api<{ trace_id: string }>("/v1/trace", { method: "POST", body: JSON.stringify({ name: "refund", project, input: "Refund order 4512", output: "Order not found", children: [lookup, lookup, lookup] }) });
  const route = `reviews?project=${project}`;
  await expect.poll(async () => (await api<{ items: { finding: { id: string } }[] }>(`/api/reviews?project=${project}`)).items.length).toBeGreaterThanOrEqual(2);
  return { project, trace_id, route };
}

test("reviews evidence, advances, persists after reload and keeps resolution separate", async ({ page }) => {
  const errors = watchErrors(page);
  const { route, project } = await seedReviewRun();
  await open(page, route);
  await expect(page.getByText("Finding reviews", { exact: true })).toBeVisible();
  const first = page.locator("tbody tr").first().getByRole("button");
  const title = (await first.textContent())!;
  await first.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByTestId("review-evidence")).toContainText("4512");
  await expect(sheet.getByRole("button", { name: "Save review and next" })).toBeDisabled();
  const selected = new URL(page.url()).hash.split("item=")[1];
  await sheet.getByRole("radio", { name: "Confirmed problem" }).check();
  await sheet.getByRole("textbox", { name: "Review reason" }).fill("The same lookup failed three times.");
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  // Findings can share a timestamp; their IDs break ties, so the next check is not fixed.
  await expect.poll(() => new URL(page.url()).hash.split("item=")[1]).not.toBe(selected);
  await expect(sheet.getByTestId("review-evidence")).toBeVisible();
  await expect(sheet.getByText(title, { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Review status" }).click();
  await page.getByRole("option", { name: "Confirmed problem", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "Confirmed problem" })).toBeChecked();
  await expect(sheet.getByRole("textbox", { name: "Review reason" })).toHaveValue("The same lookup failed three times.");
  await api(`/api/findings/${selected}`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
  await sheet.getByRole("button", { name: "Reload evidence" }).click();
  await expect(sheet.getByText("Finding: resolved", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Needs review again", { exact: true })).toHaveCount(0);
  await sheet.getByRole("radio", { name: "Unsure", exact: true }).check();
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  await expect(sheet).toHaveCount(0);
  const saved = await api<{ items: { review: { verdict: string }; finding: { status: string } }[] }>(`/api/reviews?project=${project}&state=uncertain`);
  expect(saved.items[0]).toMatchObject({ review: { verdict: "uncertain" }, finding: { status: "resolved" } });
  expect(errors).toEqual([]);
});

test("text filters preserve the caret, debounce requests and replace history", async ({ page }) => {
  const { route, project } = await seedReviewRun();
  await page.route("**/api/events", (r) => r.fulfill({ contentType: "text/event-stream", body: ": quiet\n\n" }));
  await open(page, `${route}&limit=1`);
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.clock.install();
  const requests: URL[] = [];
  page.on("request", (r) => { const url = new URL(r.url()); if (url.pathname === "/api/reviews") requests.push(url); });
  const historyLength = await page.evaluate(() => history.length);
  const projectInput = page.getByRole("textbox", { name: "Filter project" });
  const checkInput = page.getByRole("textbox", { name: "Filter check" });
  await projectInput.focus();
  await projectInput.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));
  await projectInput.pressSequentially("X");
  const edited = `${project[0]}X${project.slice(1)}`;
  await expect(projectInput).toHaveValue(edited);
  expect(await projectInput.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
  await checkInput.pressSequentially("repeated-tool-call");
  expect(requests).toHaveLength(0);
  await page.clock.runFor(250);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].searchParams.get("project")).toBe(edited);
  expect(requests[0].searchParams.get("check")).toBe("repeated-tool-call");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.evaluate(() => { location.hash = "#/reviews?project=restored&check=another-check"; });
  await expect(projectInput).toHaveValue("restored");
  await expect(checkInput).toHaveValue("another-check");
  await page.goBack();
  await expect(projectInput).toHaveValue(edited);
  await expect(checkInput).toHaveValue("repeated-tool-call");
  await page.clock.runFor(500);
  await expect(projectInput).toHaveValue(edited);
  await projectInput.fill("");
  await checkInput.fill("");
  await page.clock.runFor(250);
  await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split("?")[1]).has("project")).toBe(false);
  const cleared = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  expect(cleared.has("check")).toBe(false);
  expect(cleared.get("limit")).toBe("1");
});

test("stale evidence rejects save and preserves the draft until explicit reload", async ({ page }) => {
  const { route, project, trace_id } = await seedReviewRun();
  await open(page, route);
  await page.locator("tbody tr").first().getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "False positive", exact: true }).check();
  const selected = new URL(page.url()).hash.split("item=")[1];
  await sheet.getByRole("textbox", { name: "Review reason" }).fill("Keep my draft while I inspect the update.");
  // A late span changes the run's evidence without touching the open form.
  const ns = String(BigInt(Date.now()) * 1_000_000n);
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: project } }] }, scopeSpans: [{ scope: { name: "review-test" }, spans: [{ traceId: trace_id, spanId: randomUUID().replaceAll("-", "").slice(0, 16), name: "late context", startTimeUnixNano: ns, endTimeUnixNano: ns, attributes: [], status: { code: 1 } }] }] }] }) });
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Evidence changed");
  await expect(sheet.getByRole("textbox", { name: "Review reason" })).toHaveValue("Keep my draft while I inspect the update.");
  await sheet.getByRole("button", { name: "Reload evidence" }).click();
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  await expect(sheet.getByRole("radio", { name: "False positive", exact: true })).toBeChecked();
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  await expect.poll(() => new URL(page.url()).hash.split("item=")[1]).not.toBe(selected);
  await expect(sheet.getByTestId("review-evidence")).toBeVisible();
});

test("queue and review sheet fit light, dark and 390px layouts", async ({ page }, testInfo) => {
  const { route } = await seedReviewRun();
  await open(page, route);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => localStorage.setItem("neatroots-theme", value), theme);
    await page.reload();
    await expect(page.getByRole("button", { name: "Same tool called repeatedly with identical arguments", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`reviews-${theme}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Same tool called repeatedly with identical arguments", exact: true }).click();
    await expect(page.getByTestId("review-evidence")).toContainText("4512");
    await page.screenshot({ path: testInfo.outputPath(`review-sheet-${theme}.png`), animations: "disabled" });
    await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("reviews-390.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Same tool called repeatedly with identical arguments", exact: true }).click();
  await expect(page.getByTestId("review-evidence")).toContainText("4512");
  await expect(page.getByRole("button", { name: "Save review and next" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-sheet-390.png"), animations: "disabled" });
  await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
});

test("reopening a finding loads its latest saved judgment", async ({ page }) => {
  const { route } = await seedReviewRun();
  await open(page, `${route}&state=all`);
  const first = page.locator("tbody tr").first().getByRole("button");
  const title = (await first.textContent())!;
  await first.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("textbox", { name: "Review reason" })).toBeVisible();
  const id = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("item")!;
  await page.keyboard.press("Escape");
  const current = await api<{ evidence_version: string }>(`/api/reviews/${id}`);
  await api(`/api/reviews/${id}`, { method: "POST", body: JSON.stringify({ verdict: "incorrect", reason: "Updated from another client", source: "tool", evidence_version: current.evidence_version }) });
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "False positive", exact: true })).toBeChecked();
  await expect(sheet.getByRole("textbox", { name: "Review reason" })).toHaveValue("Updated from another client");
});

test("queue and long evidence fit narrow, wide and short landscape windows", async ({ page }, testInfo) => {
  const { route } = await seedReviewRun();
  // Real findings with deliberately long display content exercise wrapping and internal scrolling.
  await page.route("**/api/reviews/*", async (intercept) => {
    const response = await intercept.fetch();
    const item = await response.json();
    item.finding.title = "Repeated lookup " + "LongFindingName".repeat(18);
    item.finding.detail.quote = "EvidenceWithoutSpaces".repeat(40);
    await intercept.fulfill({ response, json: item });
  });
  await open(page, route);
  const sizes = [[320, 568], [360, 640], [390, 844], [568, 320], [667, 375], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await expect(page.locator("tbody tr").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const rowHeights = await page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(new Set(rowHeights).size).toBe(1);
    await page.locator("tbody tr").first().getByRole("button").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: /^Repeated lookup/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`review-${width}x${height}.png`), animations: "disabled" });
    await expect(sheet).toBeInViewport({ ratio: 1 });
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const reason = sheet.getByRole("textbox", { name: "Review reason" });
    await reason.scrollIntoViewIfNeeded();
    await reason.fill("Reason remains reachable after resizing");
    await expect(reason).toBeInViewport();
    await expect(sheet.getByRole("button", { name: "Save review and next" })).toBeInViewport();
    await page.keyboard.press("Escape");
  }
});

test("keyboard review and failed saves preserve the draft", async ({ page }) => {
  const { route } = await seedReviewRun();
  await open(page, route);
  const first = page.locator("tbody tr").first().getByRole("button");
  await first.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog");
  const radio = sheet.getByRole("radio", { name: "Unsure", exact: true });
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  const reason = sheet.getByRole("textbox", { name: "Review reason" });
  await reason.fill("Keep this draft after a failed request");
  await page.route("**/api/reviews/*", async (intercept) => {
    if (intercept.request().method() === "POST") await intercept.fulfill({ status: 503, json: { error: "Review store unavailable" } });
    else await intercept.continue();
  });
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Review store unavailable");
  await expect(reason).toHaveValue("Keep this draft after a failed request");
  await expect(radio).toBeChecked();
  await expect(sheet.getByRole("button", { name: "Save review and next" })).toBeEnabled();
});

test("paging and save-and-next cross the page boundary without skipping a finding", async ({ page }) => {
  const { route, project } = await seedReviewRun();
  // A one-item page reaches the same cursor boundary without a large, slow fixture.
  await open(page, `${route}&limit=1`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/);
  await page.getByRole("button", { name: "Restart queue", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.locator("tbody tr").first().getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("radio", { name: "Unsure", exact: true })).toBeVisible();
  const previous = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("item")!;
  const before = await api<{ items: { finding: { id: string } }[] }>(`/api/reviews?project=${project}`);
  const expected = before.items[before.items.findIndex((item) => item.finding.id === previous) + 1].finding.id;
  await sheet.getByRole("radio", { name: "Unsure", exact: true }).check();
  await sheet.getByRole("button", { name: "Save review and next" }).click();
  await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("item")).toBe(expected);
  await expect(page).toHaveURL(/cursor=/);
  await expect(sheet.getByTestId("review-evidence")).toContainText("4512");
  const saved = await api<{ review: { verdict: string } }>(`/api/reviews/${previous}`);
  expect(saved.review.verdict).toBe("uncertain");
});
