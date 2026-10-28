import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { api, open } from "./util";

test("an LLM root keeps system and user roles and recorded tool calls", async ({ page }) => {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs: Record<string, string> = {
    "neatlogs.span.kind": "llm",
    "neatlogs.llm.model_name": "test-model",
    "neatlogs.llm.input_messages.0.role": "system",
    "neatlogs.llm.input_messages.0.content": "Keep the order lookup concise.",
    "neatlogs.llm.input_messages.1.role": "user",
    "neatlogs.llm.input_messages.1.content": "Look up order 1001",
    "neatlogs.llm.output_messages.0.role": "assistant",
    "neatlogs.llm.tool_calls.0.name": "lookup_order",
    "neatlogs.llm.tool_calls.0.arguments": '{"order_id":"1001"}',
  };
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "root-llm-proof" } }] },
    scopeSpans: [{ scope: { name: "test" }, spans: [{ traceId, spanId, name: "root-llm", kind: 1,
      startTimeUnixNano: String(start), endTimeUnixNano: String(start + 1_000_000n),
      attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })), status: { code: 1 },
    }] }],
  }] }) });
  const data = await api<{ items: { type: string; text?: string }[] }>(`/api/runs/${traceId}/chat`);
  expect(data.items.map((item) => item.type)).toEqual(["system", "user", "assistant"]);
  await open(page, `runs/${traceId}`);
  const chat = page.getByTestId("chat-view");
  await expect(chat.getByText("system prompt", { exact: true })).toBeVisible();
  await expect(chat.locator("summary").filter({ hasText: "Keep the order lookup concise." })).toBeVisible();
  await expect(chat.getByText("Look up order 1001", { exact: true })).toBeVisible();
  await expect(chat.getByText("lookup_order", { exact: true })).toBeVisible();
  await expect(chat).not.toContainText("no reply recorded");
});

test("an LLM root retains its exchange beside a nested agent", async ({ page }, testInfo) => {
  const traceId = randomBytes(16).toString("hex");
  const root = randomBytes(8).toString("hex"), agent = randomBytes(8).toString("hex"), child = randomBytes(8).toString("hex");
  const start = BigInt(Date.now()) * 1_000_000n;
  const makeSpan = (spanId: string, parentSpanId: string, name: string, kind: string, attrs: Record<string, string>) => ({
    traceId, spanId, parentSpanId, name, kind: 1,
    startTimeUnixNano: String(start), endTimeUnixNano: String(start + 1_000_000n),
    attributes: Object.entries({ "neatlogs.span.kind": kind, ...attrs }).map(([key, value]) => ({ key, value: { stringValue: value } })), status: { code: 1 },
  });
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{
    resource: { attributes: [] }, scopeSpans: [{ scope: { name: "test" }, spans: [
      makeSpan(root, "", "root-llm", "llm", {
        "neatlogs.llm.input_messages.0.role": "system", "neatlogs.llm.input_messages.0.content": "Keep the delegation concise.",
        "neatlogs.llm.input_messages.1.role": "user", "neatlogs.llm.input_messages.1.content": "Delegate order lookup",
        "neatlogs.llm.output_messages.0.role": "assistant", "neatlogs.llm.output_messages.0.content": "Delegating now.",
        "neatlogs.llm.tool_calls.0.name": "delegate", "neatlogs.llm.tool_calls.0.arguments": '{"task":"lookup"}',
      }),
      makeSpan(agent, root, "Lookup agent", "agent", {}),
      makeSpan(child, agent, "child-llm", "llm", {
        "neatlogs.llm.input_messages.0.role": "user", "neatlogs.llm.input_messages.0.content": "Private lookup",
        "neatlogs.llm.output_messages.0.role": "assistant", "neatlogs.llm.output_messages.0.content": "Found it.",
      }),
    ] }] }] }) });
  await open(page, `runs/${traceId}`);
  const chat = page.getByTestId("chat-view");
  await expect(chat.getByText("Delegate order lookup", { exact: true })).toBeVisible();
  await expect(chat.getByText("Delegating now.", { exact: true })).toBeVisible();
  await expect(chat.getByText("delegate", { exact: true })).toBeVisible();
  await expect(chat).not.toContainText("Private lookup");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { localStorage.setItem("theme", value); document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.screenshot({ path: testInfo.outputPath(`274-${theme}-${width}.png`), fullPage: true });
    }
  }
});
