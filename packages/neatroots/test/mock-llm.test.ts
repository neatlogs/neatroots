import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mockReply, startMockLlm } from "../src/dev/mock-llm.js";
import { freePort } from "./helpers.js";

let server: http.Server | undefined;
afterEach(() => server?.close());

const tools = [{ name: "lookup_order", description: "Look up an order by id", parameters: { properties: { order_id: { type: "string" } } } }, { name: "issue_refund", description: "Refund an order", parameters: { properties: { order_id: { type: "string" }, amount: { type: "number" } } } }];

describe("mock LLM", () => {
  it("calls the matching tool, then answers from its result; sloppy ignores failures", () => {
    expect(mockReply([{ role: "user", content: "Please refund order 4512" }], tools, "mock").toolCall).toEqual({ name: "issue_refund", args: { order_id: "4512", amount: 1 } });
    const after = [{ role: "user", content: "Look up order 1001" }, { role: "assistant", content: "" }, { role: "tool", content: '{"error":"order not found"}' }];
    expect(mockReply(after, tools, "mock").content).toMatch(/couldn't complete/);
    expect(mockReply(after, tools, "mock-sloppy").content).toMatch(/successfully/);
  });

  it("serves OpenAI chat completions (plain and streamed) and Anthropic messages", async () => {
    const port = await freePort();
    server = await startMockLlm(port);
    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "look up order 7" }], tools: tools.map((f) => ({ type: "function", function: f })) }) }).then((r) => r.json() as Promise<any>);
    expect(chat.choices[0].message.tool_calls[0].function.name).toBe("lookup_order");
    const stream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mock", stream: true, messages: [{ role: "user", content: "hi" }] }) }).then((r) => r.text());
    expect(stream).toContain("[DONE]");
    const msg = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "mock", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }) }).then((r) => r.json() as Promise<any>);
    expect(msg.content[0].type).toBe("text");
  });
});
