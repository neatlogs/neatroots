import { expect, test } from "@playwright/test";
import { open, state } from "./util";

// Another site must not be able to show the app in a frame and click through it (clickjacking).
test.describe("framing", () => {
  test("the app loads on its own but refuses to render inside another page's frame", async ({ page }) => {
    await open(page, "runs");
    await expect(page.getByRole("cell", { name: "Is order 1001 ok?" })).toBeVisible();

    const other = await page.context().newPage();
    const response = other.waitForResponse((r) => r.url().startsWith(state().url));
    await other.setContent(`<iframe id="f" src="${state().url}/#/runs" width="800" height="600"></iframe>`);
    expect((await response).headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    const frame = other.frameLocator("#f");
    // The browser blocks the frame, so the app never renders inside it.
    await other.waitForTimeout(1500);
    await expect(frame.getByRole("cell", { name: "Is order 1001 ok?" })).toHaveCount(0);
    await other.close();
  });
});
