import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, state } from "./util";

async function recordedCall(mode: "stream" | "missing" | "partial" | "zero") {
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  const start = BigInt(Date.now() - 1000) * 1_000_000n;
  const attr = (key: string, value: string | number) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } });
  const chunks = mode === "missing" ? [] : mode === "zero" ? [[0, 0, 5]] : [[0, 190, 0], [mode === "partial" ? 2 : 1, 494, 5]];
  await api("/v1/traces", {
    method: "POST",
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [attr("service.name", "stream-timing-e2e")] }, scopeSpans: [{ scope: { name: "stream-timing-e2e" }, spans: [{
      traceId, spanId, name: "Streaming timing example", kind: 1,
      startTimeUnixNano: String(start), endTimeUnixNano: String(start + 927_000_000n), status: { code: 1 },
      attributes: [attr("neatlogs.span.kind", "llm"), attr("neatlogs.llm.model_name", "recorded-model"), attr("neatlogs.llm.input_messages.0.role", "user"), attr("neatlogs.llm.input_messages.0.content", "Explain response timing"), attr("neatlogs.llm.output_messages.0.role", "assistant"), attr("neatlogs.llm.output_messages.0.content", "A recorded response")],
      events: chunks.map(([index, ms, bytes]) => ({ name: "neatlogs.stream.chunk", timeUnixNano: String(start + BigInt(ms) * 1_000_000n), attributes: [attr("neatlogs.stream.chunk.index", index), attr("neatlogs.stream.chunk.summary", JSON.stringify({ choices: [{ content_bytes: bytes }] }))] })),
    }] }] }] }),
  });
  return traceId;
}

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    test(`first chunk and first text in ${theme} at ${width}px`, async ({ page }, info) => {
      const id = await recordedCall("stream");
      try {
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript((theme) => localStorage.setItem("neatroots-theme", theme), theme);
        await page.goto(`${state().url}/#/runs/${id}`);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "View span", exact: true }).first().click();
        const sheet = page.getByRole("dialog");
        await expect.poll(async () => {
          const box = await sheet.boundingBox();
          return box ? box.x + box.width : Infinity;
        }).toBeLessThanOrEqual(width + 1);
        await expect(sheet.getByText("First chunk: 190 ms", { exact: true })).toBeVisible();
        await expect(sheet.getByText("First text: 494 ms", { exact: true })).toBeVisible();
        await expect(sheet.getByText("First text: 494 ms", { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(sheet.getByText(/927 ms/)).toBeVisible();
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const box = await sheet.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`${theme}-${width}.png`), animations: "disabled" });
      } finally { await api(`/api/runs/${id}`, { method: "DELETE" }); }
    });
  }
}

for (const mode of ["missing", "partial", "zero"] as const) {
  test(`timing remains honest for ${mode} evidence`, async ({ page }) => {
    const id = await recordedCall(mode);
    try {
      await page.goto(`${state().url}/#/runs/${id}`);
      await page.getByRole("button", { name: "View span", exact: true }).first().click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByText(`First chunk: ${mode === "missing" ? "not captured" : mode === "zero" ? "<1 ms" : "190 ms"}`, { exact: true })).toBeVisible();
      await expect(sheet.getByText(`First text: ${mode === "zero" ? "<1 ms" : "not captured"}`, { exact: true })).toBeVisible();
    } finally { await api(`/api/runs/${id}`, { method: "DELETE" }); }
  });
}
