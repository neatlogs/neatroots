import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, open } from "./util";
import type { RunDetail } from "../src/lib/api";

const attr = (key: string, value: unknown) => ({ key, value });

test("explicit cancelled calls are abandoned across run views; errors win", async ({ page }, info) => {
  const traceId = crypto.randomBytes(16).toString("hex");
  const cases = ["cancelled", "completed", "missing", "string", "error", "exception", "tool"];
  const spans = cases.map((name, i) => ({
    traceId, parentSpanId: "ffffffffffffffff", spanId: (i + 1).toString(16).padStart(16, "0"), name,
    startTimeUnixNano: String(BigInt(Date.now() - 1000 + i * 10) * 1000000n),
    endTimeUnixNano: String(BigInt(Date.now() - 900 + i * 10) * 1000000n),
    status: { code: name === "error" ? 2 : 1 },
    attributes: [
      attr("neatlogs.span.kind", { stringValue: name === "tool" ? "TOOL" : "LLM" }),
      attr("neatlogs.llm.output_messages.0.role", { stringValue: "assistant" }),
      attr("neatlogs.llm.output_messages.0.content", { stringValue: name }),
      ...(name === "missing" ? [] : [attr("neatlogs.stream.cancelled", name === "string" ? { stringValue: "true" } : { boolValue: name !== "completed" })]),
    ],
    events: name === "exception" ? [{ name: "exception", timeUnixNano: "1", attributes: [attr("exception.message", { stringValue: "fixture exception" })] }] : [],
  }));
  spans.push({ ...spans[0], spanId: "ffffffffffffffff", parentSpanId: "", name: "stream-controls", attributes: [attr("neatlogs.span.kind", { stringValue: "WORKFLOW" })] });
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "abandoned-ui" }, spans }] }] }) });
  const detail = await api<RunDetail>(`/api/runs/${traceId}`);
  expect(detail.spans.filter((s) => s.name !== "stream-controls").map((s) => [s.name, s.stream_cancelled]).sort()).toEqual([
    ["cancelled", true], ["completed", false], ["error", true], ["exception", true], ["missing", false], ["string", false], ["tool", true],
  ]);
  expect(detail.spans.find((s) => s.name === "exception")?.error).toContain("fixture exception");
  await open(page, `runs/${traceId}`);
  const views = page.getByTestId("run-views");
  await expect(views.getByText("Abandoned", { exact: true })).toHaveCount(1);
  await expect(views.getByText("Failed", { exact: true })).toHaveCount(2);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const view of ["Overview", "Trace", "Timeline"]) {
        await views.getByRole("tab", { name: view, exact: true }).click();
        await expect(views.getByText("Abandoned", { exact: true })).toHaveCount(1);
        await expect(views.getByText("Failed", { exact: true })).toHaveCount(2);
        await page.screenshot({ path: info.outputPath(`${theme}-${width}-${view}.png`), fullPage: true, animations: "disabled" });
      }
      await views.getByRole("tab", { name: "Trace", exact: true }).click();
      await views.getByRole("treeitem", { name: /^cancelled / }).click();
      await expect(page.getByRole("dialog").getByText("Abandoned", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-Detail.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }
  }
  await views.getByRole("tab", { name: "Trace", exact: true }).click();
  await views.getByRole("treeitem", { name: /^cancelled / }).click();
  await expect(page.getByRole("dialog").getByText("Abandoned", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // A corrected export replaces the marker; presentation must follow the stored value.
  const corrected = { ...spans[0], attributes: spans[0].attributes.map((a) => a.key === "neatlogs.stream.cancelled" ? attr(a.key, { boolValue: false }) : a) };
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "abandoned-ui" }, spans: [corrected] }] }] }) });
  expect((await api<RunDetail>(`/api/runs/${traceId}`)).spans.find((s) => s.name === "cancelled")?.stream_cancelled).toBe(false);
  await page.reload();
  await expect(page.getByRole("treeitem", { name: /^cancelled / })).toBeVisible();
  await expect(page.getByTestId("run-views").getByText("Abandoned", { exact: true })).toHaveCount(0);
});

