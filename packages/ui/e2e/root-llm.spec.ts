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

test("an LLM wrapper shows its child reply once", async ({ page }) => {
  const traceId = randomBytes(16).toString("hex");
  const root = randomBytes(8).toString("hex");
  const child = randomBytes(8).toString("hex");
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = {
    "neatlogs.span.kind": "llm",
    "neatlogs.llm.input_messages.0.role": "user",
    "neatlogs.llm.input_messages.0.content": "Say hello once",
    "neatlogs.llm.output_messages.0.role": "assistant",
    "neatlogs.llm.output_messages.0.content": "Hello from the wrapped call.",
  };
  await api("/v1/traces", { method: "POST", body: JSON.stringify({ resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "wrapped-llm-proof" } }] },
    scopeSpans: [{ scope: { name: "test" }, spans: [root, child].map((spanId, i) => ({
      traceId, spanId, ...(i ? { parentSpanId: root } : {}), name: i ? "child-llm" : "wrapper-llm", kind: 1,
      startTimeUnixNano: String(start + BigInt(i)), endTimeUnixNano: String(start + 1_000_000n),
      attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })), status: { code: 1 },
    })) }],
  }] }) });
  const data = await api<{ items: { type: string; text?: string; span_id: string }[] }>(`/api/runs/${traceId}/chat`);
  expect(data.items).toEqual([
    expect.objectContaining({ type: "user", text: "Say hello once", span_id: child }),
    expect.objectContaining({ type: "assistant", text: "Hello from the wrapped call.", span_id: child }),
  ]);
  await open(page, `runs/${traceId}`);
  const chat = page.getByTestId("chat-view");
  await expect(chat.getByText("Say hello once", { exact: true })).toHaveCount(1);
  await expect(chat.getByText("Hello from the wrapped call.", { exact: true })).toHaveCount(1);
});
