import { afterEach, describe, expect, it } from "vitest";
import { collectIndexed } from "../src/semantics/view.js";
import { makeRoots, type TestRoots } from "./helpers.js";

let tb: TestRoots | undefined;
afterEach(async () => {
  await tb?.close();
  tb = undefined;
});

const str = (key: string, v: string) => ({ key, value: { stringValue: v } });

describe("OpenInference message contents and tool calls (#219)", () => {
  it("converts nested numeric-keyed attribute groups into sorted arrays in collectIndexed", () => {
    const rows = collectIndexed(
      {
        "llm.input_messages.0.message.role": "user",
        "llm.input_messages.0.message.contents.1.message_content.text": "second part",
        "llm.input_messages.0.message.contents.0.message_content.text": "first part",
      },
      "llm.input_messages",
    );
    const msg = rows[0]?.message as Record<string, unknown>;
    expect(Array.isArray(msg.contents)).toBe(true);
    expect(msg.contents).toEqual([
      { message_content: { text: "first part" } },
      { message_content: { text: "second part" } },
    ]);
  });

  it("extracts Responses API message.contents text and message.tool_calls into previews, Conversation and search", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const traceId = "5b8efff798038103d269b633813fc60c";
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [str("service.name", "oi-repro")] },
          scopeSpans: [
            {
              scope: { name: "openinference.instrumentation.openai" },
              spans: [
                {
                  traceId,
                  spanId: "eee19b7ec3c1b174",
                  name: "agent",
                  kind: 1,
                  startTimeUnixNano: "1760600000000000000",
                  endTimeUnixNano: "1760600002000000000",
                  attributes: [str("openinference.span.kind", "AGENT")],
                  status: { code: 1 },
                },
                {
                  traceId,
                  spanId: "eee19b7ec3c1b175",
                  parentSpanId: "eee19b7ec3c1b174",
                  name: "Response",
                  kind: 1,
                  startTimeUnixNano: "1760600000100000000",
                  endTimeUnixNano: "1760600001000000000",
                  attributes: [
                    str("openinference.span.kind", "LLM"),
                    str("llm.model_name", "gpt-4.1"),
                    str("llm.input_messages.0.message.role", "user"),
                    str("llm.input_messages.0.message.contents.0.message_content.type", "text"),
                    str("llm.input_messages.0.message.contents.0.message_content.text", "Where is order 1001?"),
                    str("llm.output_messages.0.message.role", "assistant"),
                    str("llm.output_messages.0.message.tool_calls.0.tool_call.id", "call_1"),
                    str("llm.output_messages.0.message.tool_calls.0.tool_call.function.name", "lookup_order"),
                    str("llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments", '{"order_id":"1001"}'),
                  ],
                  status: { code: 1 },
                },
                {
                  traceId,
                  spanId: "eee19b7ec3c1b176",
                  parentSpanId: "eee19b7ec3c1b174",
                  name: "Response",
                  kind: 1,
                  startTimeUnixNano: "1760600001100000000",
                  endTimeUnixNano: "1760600001900000000",
                  attributes: [
                    str("openinference.span.kind", "LLM"),
                    str("llm.model_name", "gpt-4.1"),
                    str("llm.output_messages.0.message.role", "assistant"),
                    str("llm.output_messages.0.message.contents.0.message_content.type", "text"),
                    str("llm.output_messages.0.message.contents.0.message_content.text", "Order 1001 shipped on Monday."),
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const ingestRes = await fetch(`${tb.url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(ingestRes.status).toBe(200);

    const detail = await (await fetch(`${tb.url}/api/runs/${traceId}`)).json();
    const firstLlm = detail.spans.find((s: { span_id: string }) => s.span_id === "eee19b7ec3c1b175");
    const secondLlm = detail.spans.find((s: { span_id: string }) => s.span_id === "eee19b7ec3c1b176");
    expect(firstLlm.input_preview).toBe("user: Where is order 1001?");
    expect(firstLlm.output_preview).toBe('assistant:  → lookup_order({"order_id":"1001"})');
    expect(secondLlm.output_preview).toBe("assistant: Order 1001 shipped on Monday.");

    const chat = await (await fetch(`${tb.url}/api/runs/${traceId}/chat`)).json();
    expect(chat.items).toEqual([
      {
        type: "user",
        text: "Where is order 1001?",
        span_id: "eee19b7ec3c1b175",
      },
      {
        type: "assistant",
        text: "",
        span_id: "eee19b7ec3c1b175",
        model: "gpt-4.1",
        tool_calls: [{ name: "lookup_order", arguments: { order_id: "1001" } }],
      },
      {
        type: "assistant",
        text: "Order 1001 shipped on Monday.",
        span_id: "eee19b7ec3c1b176",
        model: "gpt-4.1",
        tool_calls: [],
      },
    ]);

    const search = await (await fetch(`${tb.url}/api/search/runs?q=shipped`)).json();
    expect(search.total).toBe(1);
    expect(search.runs[0].trace_id).toBe(traceId);
  });

  it("reads multimodal user messages with text and image parts", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const traceId = "6b8efff798038103d269b633813fc60d";
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [str("service.name", "oi-multimodal")] },
          scopeSpans: [
            {
              scope: { name: "openinference.instrumentation.openai" },
              spans: [
                {
                  traceId,
                  spanId: "aaa19b7ec3c1b170",
                  name: "agent",
                  kind: 1,
                  startTimeUnixNano: "1760600000000000000",
                  endTimeUnixNano: "1760600001000000000",
                  attributes: [str("openinference.span.kind", "AGENT")],
                  status: { code: 1 },
                },
                {
                  traceId,
                  spanId: "aaa19b7ec3c1b174",
                  parentSpanId: "aaa19b7ec3c1b170",
                  name: "ChatCompletion",
                  kind: 1,
                  startTimeUnixNano: "1760600000100000000",
                  endTimeUnixNano: "1760600000900000000",
                  attributes: [
                    str("openinference.span.kind", "LLM"),
                    str("llm.model_name", "gpt-4o"),
                    str("llm.input_messages.0.message.role", "user"),
                    str("llm.input_messages.0.message.contents.0.message_content.type", "text"),
                    str("llm.input_messages.0.message.contents.0.message_content.text", "What is on this receipt?"),
                    str("llm.input_messages.0.message.contents.1.message_content.type", "image"),
                    str("llm.input_messages.0.message.contents.1.message_content.image.image.url", "https://example.com/receipt.png"),
                    str("llm.output_messages.0.message.role", "assistant"),
                    str("llm.output_messages.0.message.content", "The total is $42.00."),
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await fetch(`${tb.url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const chat = await (await fetch(`${tb.url}/api/runs/${traceId}/chat`)).json();
    expect(chat.items).toEqual([
      {
        type: "user",
        text: "What is on this receipt?",
        span_id: "aaa19b7ec3c1b174",
      },
      {
        type: "assistant",
        text: "The total is $42.00.",
        span_id: "aaa19b7ec3c1b174",
        model: "gpt-4o",
        tool_calls: [],
      },
    ]);
  });
});
