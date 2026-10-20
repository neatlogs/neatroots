import { expect, test } from "@playwright/test";
import { open, state, watchErrors } from "./util";

test.describe("run page", () => {
  test("leads with the problems a rule found", async ({ page }) => {
    await open(page, `runs/${state().supportRun}`);
    const problems = page.getByTestId("problems");
    await expect(problems).toBeVisible();
    await expect(problems.getByText(/secret key/i).first()).toBeVisible();
  });

  test("one retry loop that trips several checks shows as one problem", async ({ page }) => {
    await open(page, `runs/${state().loopRun}`);
    const problems = page.getByTestId("problems");
    await expect(problems.getByText("1 problem", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(problems.getByText("Also matched")).toBeVisible();
    await expect(problems.getByText(/Same tool called repeatedly|Several tool calls failed in a row/).first()).toBeVisible();
    // The run's side panel counts problems the same way.
    await expect(page.locator("body")).toContainText(/Open problems\s*1(?!\d)/);
  });

  test("a run whose spans' parents point at each other still opens, with every span shown", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, `runs/${state().cycleRun}`);
    const views = page.getByTestId("run-views");
    await views.getByRole("tab", { name: "Trace" }).click();
    await expect(views.getByRole("treeitem", { name: /cycle-agent/ })).toBeVisible();
    await expect(views.getByRole("treeitem", { name: /cycle-tool/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("says how much of the run was checked, next to the result", async ({ page }) => {
    await open(page, `runs/${state().researchRun}`);
    // Rules always run; the question count comes from the run's plan and the baseline questions.
    await expect(page.getByTestId("problems").getByText(/\d+ of \d+ questions answered · rules on every span/)).toBeVisible({ timeout: 30_000 });
  });

  test("Overview reads the run as a conversation", async ({ page }) => {
    await open(page, `runs/${state().supportRun}`);
    const chat = page.getByTestId("chat-view");
    await expect(chat.getByText("Is order 1001 ok?")).toBeVisible();
    await expect(chat.getByText("lookup_order").first()).toBeVisible();
    await expect(chat.getByText(/Order 1001 was delivered/)).toBeVisible();
    await chat.getByText("Show input and output").click();
    await expect(chat.getByText('"status": "delivered"')).toBeVisible();
  });

  test("editing a user message forks the LLM call into a new run", async ({ page }) => {
    await open(page, `runs/${state().supportRun}`);
    const chat = page.getByTestId("chat-view");
    await chat.getByText("Is order 1001 ok?").hover();
    await chat.getByRole("button", { name: "Edit and fork" }).click();
    await chat.getByRole("textbox", { name: "Edited message" }).fill("Is order 2002 ok?");
    await chat.getByRole("button", { name: "Re-run this LLM call" }).click();
    await expect(page.getByText(/Replay of/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/one LLM call/)).toBeVisible();
    await page.getByRole("link", { name: /^run [0-9a-f]{8}$/ }).click();
    await expect(page.getByTestId("replays")).toBeVisible();
  });

  test("Trace, Timeline and Conversation views, and the span sheet", async ({ page }) => {
    await open(page, `runs/${state().supportRun}`);
    const views = page.getByTestId("run-views");
    await views.getByRole("tab", { name: "Trace" }).click();
    await expect(page).toHaveURL(/view=trace/);
    await views.getByRole("treeitem", { name: /lookup_order/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("lookup_order").first()).toBeVisible();
    await sheet.getByRole("tab", { name: "Attributes" }).click();
    await expect(sheet.getByText("neatlogs.tool.name")).toBeVisible();
    await page.keyboard.press("Escape");
    await views.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect(page.getByTestId("timeline").getByText("lookup_order")).toBeVisible();
    await views.getByRole("tab", { name: "Conversation" }).click();
    await expect(views.getByText("Turn 1")).toBeVisible();
    await expect(views.getByText("Turn 2")).toBeVisible();
    await expect(views.getByText("this run")).toBeVisible();
  });

  test("a sub-agent opens as its own conversation", async ({ page }) => {
    await open(page, `runs/${state().researchRun}`);
    const views = page.getByTestId("run-views");
    await expect(views.getByText("researcher")).toBeVisible();
    await views.getByRole("button", { name: "Open sub-agent" }).first().click();
    await expect(views.getByText("Summarise the search results")).toBeVisible();
    await views.getByRole("button", { name: "Run", exact: true }).click();
    await expect(views.getByText("writer")).toBeVisible();
  });

  test("the replay dialog explains how to set up a whole-run replay, and replays one LLM call", async ({ page }) => {
    await open(page, `runs/${state().secondTurn}`);
    await page.getByRole("button", { name: "Replay" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/doesn't know how to start/)).toBeVisible();
    await dialog.getByRole("tab", { name: "One LLM call" }).click();
    await expect(dialog.getByText("system", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Replay LLM call" }).click();
    await expect(page.getByText(/Replay of/)).toBeVisible({ timeout: 20_000 });
  });

  test("the More menu re-runs checks and links to a coding agent", async ({ page }) => {
    await open(page, `runs/${state().supportRun}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Re-run checks" }).click();
    await expect(page.getByText("Re-running checks on this run")).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Ask a coding agent" }).click();
    await expect(page).toHaveURL(/#\/agents\?trace=/);
  });

  test("a failed run shows its error", async ({ page }) => {
    await open(page, `runs/${state().failedRun}?view=trace`);
    await expect(page.getByText("Failed").first()).toBeVisible();
    await page.getByTestId("run-views").getByRole("treeitem", { name: /issue_refund/ }).click();
    await expect(page.getByRole("dialog").getByText("payment gateway timeout").first()).toBeVisible();
  });
});
