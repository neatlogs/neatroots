import { expect, test } from "@playwright/test";
import { api, open, state, watchErrors } from "./util";

interface CheckList {
  checks: { id: string; precision: { confirmed: number } }[];
}

test("confirming a finding counts toward its check and can be taken back", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, `runs/${state().supportRun}`);
  const problems = page.getByTestId("problems");
  await expect(problems.getByText(/secret key/i).first()).toBeVisible();
  // The open row can group several checks' findings, so compare the total over all checks.
  const confirmedNow = async () => (await api<CheckList>("/api/checks")).checks.reduce((n, c) => n + c.precision.confirmed, 0);
  const before = await confirmedNow();

  await problems.getByRole("button", { name: "Confirm finding" }).first().click();
  await expect(page.getByText("Finding confirmed")).toBeVisible();
  await expect(problems.getByText(/Confirmed by you/).first()).toBeVisible();
  await expect.poll(confirmedNow).toBeGreaterThan(before);

  // It is stored, not just shown: still confirmed after a reload.
  await page.reload();
  await expect(problems.getByRole("button", { name: "Remove confirmation" }).first()).toBeVisible();

  await problems.getByRole("button", { name: "Remove confirmation" }).first().click();
  await expect(page.getByText("Confirmation removed")).toBeVisible();
  await expect(problems.getByRole("button", { name: "Confirm finding" }).first()).toBeVisible();
  await expect(problems.getByText(/Confirmed by you/)).toHaveCount(0);
  await expect.poll(confirmedNow).toBe(before);
  expect(errors).toEqual([]);
});
