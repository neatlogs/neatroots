import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { open, state, watchErrors } from "./util";

const hex = (n: number) => crypto.randomBytes(n).toString("hex");
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** Sends a run with one finished and one abandoned streamed reply; each call gets its own trace. */
async function sendRun(): Promise<string> {
  const traceId = hex(16);
  const now = BigInt(Date.now()) * 1_000_000n;
  const call = (name: string, offsetMs: number, extra: { key: string; value: unknown }[]) => ({
    traceId,
    spanId: hex(8),
    name,
    kind: 1,
    startTimeUnixNano: String(now + BigInt(offsetMs) * 1_000_000n),
    endTimeUnixNano: String(now + BigInt(offsetMs + 40) * 1_000_000n),
    attributes: [str("neatlogs.span.kind", "llm"), str("neatlogs.llm.model_name", "gpt-4o-mini"), ...extra],
    status: { code: 1 },
  });
  const spans = [call("finished-reply", 0, []), call("abandoned-reply", 100, [{ key: "neatlogs.stream.cancelled", value: { boolValue: true } }])];
  const res = await fetch(`${state().url}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [str("service.name", "stream-e2e")] }, scopeSpans: [{ scope: { name: "e2e" }, spans }] }] }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return traceId;
}

test("an abandoned streamed reply is labelled in the trace and the span sheet", async ({ page }) => {
  const errors = watchErrors(page);
  const traceId = await sendRun();
  await open(page, `runs/${traceId}`);
  await expect(page.getByTestId("problems").getByText(/streamed model reply was abandoned/i)).toBeVisible({ timeout: 15_000 });

  const views = page.getByTestId("run-views");
  await views.getByRole("tab", { name: "Trace" }).click();
  const abandoned = views.getByRole("treeitem", { name: /abandoned-reply/ });
  const finished = views.getByRole("treeitem", { name: /finished-reply/ });
  await expect(abandoned.getByText("abandoned", { exact: true })).toBeVisible();
  await expect(finished.getByText("abandoned", { exact: true })).toHaveCount(0);

  await abandoned.click();
  await expect(page.getByRole("dialog").getByText("Abandoned", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await finished.click();
  await expect(page.getByRole("dialog").getByText("finished-reply")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Abandoned", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
