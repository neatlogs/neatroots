import { expect, test, type Page } from "@playwright/test";
import { state } from "./util";

type Save = { cloud_endpoint: string; redact_patterns: string[] };
async function cloudForm(page: Page) {
  let patterns = ["secret_[0-9]+"];
  let endpoint = "https://ingest.neatlogs.com";
  let statusReads = 0;
  let hold: Promise<void> | undefined;
  let reject = false;
  const saves: Save[] = [];
  await page.clock.install();
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/status") {
      statusReads++;
      await route.fulfill({ json: { version: "test", port: 4100, home: "/mock", stats: { runs: 0, spans: 0, findings: 0, bytes: 0 }, engine: null, tier: { tier: "test", memoryGb: 16, description: "test", platform: "test" }, steering: { enabled: true, hooks_connected: 0 }, cloud: { endpoint, has_key: false, has_token: false, redact_patterns: patterns }, check_errors: [] } });
    } else if (pathname === "/api/settings") {
      const submitted = route.request().postDataJSON() as Save;
      saves.push(submitted);
      if (reject) { reject = false; await route.fulfill({ status: 400, json: { error: "mock rejection" } }); return; }
      patterns = [...submitted.redact_patterns]; endpoint = submitted.cloud_endpoint;
      await hold;
      await route.fulfill({ json: { ok: true, projects: [] } });
    } else if (pathname === "/api/events") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
    } else {
      await route.fulfill({ json: { forwards: [], projects: [], pushes: [] } });
    }
  });
  await page.goto(`${process.env.NEATROOTS_E2E_URL ?? state().url}/#/settings/cloud`);
  const box = page.getByRole("textbox", { name: "Extra redaction patterns" });
  const save = page.getByRole("button", { name: "Save cloud settings" });
  await expect(box).toHaveValue("secret_[0-9]+");
  return {
    box, save, saves,
    update: (value: string[], region = endpoint) => { patterns = value; endpoint = region; },
    stored: () => patterns,
    rejectNext: () => { reject = true; },
    delayNext: () => { let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; }); return () => { release(); hold = undefined; }; },
    refresh: async () => { const before = statusReads; await page.clock.fastForward(10_100); await expect.poll(() => statusReads).toBeGreaterThan(before); },
  };
}

test("cloud patterns hydrate and unchanged, edited and empty values save with the endpoint", async ({ page }) => {
  const f = await cloudForm(page);
  await f.save.click();
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0]).toEqual({ cloud_endpoint: "https://ingest.neatlogs.com", redact_patterns: ["secret_[0-9]+"] });
  await expect(f.save).toBeEnabled();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /EU/ }).click();
  await f.box.fill("cust_[0-9]+\naccount_[A-Z]+");
  await f.save.click();
  await expect.poll(f.stored).toEqual(["cust_[0-9]+", "account_[A-Z]+"]);
  expect(f.saves[1].cloud_endpoint).toBe("https://eu.ingest.neatlogs.com");
  await expect(f.save).toBeEnabled();
  await f.box.fill("");
  await f.save.click();
  await expect.poll(f.stored).toEqual([]);
  await expect(f.box).toHaveValue("");
});

test("background status refresh hydrates a clean form but preserves a dirty draft", async ({ page }) => {
  const f = await cloudForm(page);
  f.update(["external_[0-9]+"]);
  await f.refresh();
  await expect(f.box).toHaveValue("external_[0-9]+");
  await f.box.fill("draft_[0-9]+");
  f.update(["another_external"]);
  await f.refresh();
  await expect(f.box).toHaveValue("draft_[0-9]+");
});

test("a save response preserves newer edits and only a later unchanged save clears dirty state", async ({ page }) => {
  const f = await cloudForm(page);
  await f.box.fill("submitted");
  const release = f.delayNext();
  await f.save.click();
  await expect.poll(() => f.saves.length).toBe(1);
  await f.box.fill("newer draft");
  release();
  await expect(f.save).toBeEnabled();
  await f.refresh();
  await expect(f.box).toHaveValue("newer draft");
  expect(f.stored()).toEqual(["submitted"]);
  await f.save.click();
  await expect.poll(f.stored).toEqual(["newer draft"]);
  await expect(f.save).toBeEnabled();
  f.update(["external after save"]);
  await f.refresh();
  await expect(f.box).toHaveValue("external after save");
});

test("a rejected save keeps the draft through background refresh and retry", async ({ page }) => {
  const f = await cloudForm(page);
  await f.box.fill("keep this draft");
  f.rejectNext();
  await f.save.click();
  await expect(page.getByText(/Couldn't save settings/)).toBeVisible();
  f.update(["external"]);
  await f.refresh();
  await expect(f.box).toHaveValue("keep this draft");
  await f.save.click();
  await expect.poll(f.stored).toEqual(["keep this draft"]);
});

test("a delayed clean save preserves newer hydrated endpoint and patterns", async ({ page }) => {
  const f = await cloudForm(page);
  const region = page.getByRole("combobox").first();
  const release = f.delayNext();
  await f.save.click();
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0]).toEqual({ cloud_endpoint: "https://ingest.neatlogs.com", redact_patterns: ["secret_[0-9]+"] });
  f.update(["newer_external"], "https://eu.ingest.neatlogs.com");
  await f.refresh();
  await expect(region).toContainText("EU");
  await expect(f.box).toHaveValue("newer_external");
  release();
  await expect(f.save).toBeEnabled();
  await expect(region).toContainText("EU");
  await expect(f.box).toHaveValue("newer_external");
});
