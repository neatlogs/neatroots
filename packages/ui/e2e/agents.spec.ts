import { expect, test } from "@playwright/test";
import { open, state, watchErrors } from "./util";

// The e2e server's Codex is e2e/fixtures/fake-codex; Claude Code isn't installed.

test.describe("coding agents", () => {
  test("shows Claude Code as not installed when its CLI isn't found", async ({ page }) => {
    await open(page, "agents");
    await expect(page.getByRole("tab", { name: "Claude Code (not installed)" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start Codex" })).toBeVisible();
  });

  test("a chat survives sending, reloading, leaving and starting a new one", async ({ page }) => {
    // QA's browser returned a value from scrollIntoView; production React then called it as an
    // effect cleanup and the whole page went blank. Do the same here.
    await page.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args: Parameters<typeof original>) {
        original.apply(this, args);
        return true as unknown as void;
      };
    });
    const errors = watchErrors(page);
    await open(page, "agents");
    await page.getByPlaceholder("~/code/my-agent").fill(state().home);
    await page.getByRole("button", { name: "Start Codex" }).click();
    await expect(page).toHaveURL(/#\/agents\/chat_/);
    const chat = page.url();

    await page.getByLabel("Message").fill("Reply with the test marker.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("E2E_CHAT_OK")).toBeVisible();
    await expect(page.getByLabel("Message")).toBeEnabled();
    await page.getByLabel("Message").fill("And once more.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("E2E_CHAT_OK")).toHaveCount(2);

    await page.reload();
    await expect(page.getByText("E2E_CHAT_OK")).toHaveCount(2);
    await page.getByRole("link", { name: "home", exact: true }).click();
    await expect(page.getByText("Runs with problems")).toBeVisible();
    await page.goto(chat);
    await expect(page.getByText("E2E_CHAT_OK").first()).toBeVisible();
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByText("Start a session")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a sign-in failure is explained in the chat and the page keeps working", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "agents");
    await page.getByPlaceholder("~/code/my-agent").fill(state().home);
    await page.getByRole("button", { name: "Start Codex" }).click();
    await page.getByLabel("Message").fill("SIGN_IN_FAIL please");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/Codex couldn't sign in/)).toBeVisible();
    await page.getByRole("link", { name: "runs", exact: true }).click();
    await expect(page.getByText("Runs", { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("lists the other connected coding agents with a way to open them", async ({ page }) => {
    await open(page, "agents");
    await expect(page.getByText("Your other coding agents")).toBeVisible();
    // Connected by the settings test on a repeat run, not yet on the first.
    await expect(page.getByRole("button", { name: "Connect Cursor" }).or(page.getByRole("link", { name: "Open Cursor" }))).toBeVisible();
    await expect(page.getByText(/look at my last run in neatroots/i)).toBeVisible();
  });

  test("opening from a run keeps the run in the URL", async ({ page }) => {
    await open(page, `agents?trace=${state().supportRun}`);
    await expect(page).toHaveURL(/trace=/);
    await expect(page.getByText("Coding agents").first()).toBeVisible();
  });
});
