import { describe, expect, it } from "vitest";
import { buildView } from "../src/semantics/view.js";
import { hex, s, span } from "./helpers.js";

describe("PydanticAI GenAI semconv spans", () => {
  const traceId = hex(16);

  it("reads final_result and pydantic_ai.all_messages on invoke_agent spans", () => {
    const agent = span({
      traceId,
      name: "invoke_agent",
      kind: "agent",
      attrs: [
        s("gen_ai.operation.name", "invoke_agent"),
        s("final_result", "Refunded order 1001."),
        s("pydantic_ai.all_messages", JSON.stringify([{ role: "user", content: "Please refund order 1001." }])),
      ],
    });
    expect(buildView(agent, [])).toMatchObject({
      kind: "AGENT",
      input: [{ role: "user", content: "Please refund order 1001." }],
      output: "Refunded order 1001.",
    });
  });

  it("reads gen_ai.tool.definitions on chat spans", () => {
    const chat = span({
      traceId,
      name: "chat",
      kind: "llm",
      attrs: [
        s(
          "gen_ai.tool.definitions",
          JSON.stringify([
            { type: "function", name: "lookup_order", description: "Look up an order", parameters: {} },
            { type: "function", name: "issue_refund", description: "Issue a refund", parameters: {} },
          ]),
        ),
      ],
    });
    expect(buildView(chat, [])).toMatchObject({
      kind: "LLM",
      tools: ["lookup_order", "issue_refund"],
    });
  });

  it("reads gen_ai.aggregated_usage token counts on agent spans", () => {
    const agent = span({
      traceId,
      name: "invoke_agent",
      kind: "agent",
      attrs: [
        s("gen_ai.operation.name", "invoke_agent"),
        s("gen_ai.aggregated_usage.input_tokens", 120),
        s("gen_ai.aggregated_usage.output_tokens", 34),
      ],
    });
    expect(buildView(agent, [])).toMatchObject({
      kind: "AGENT",
      promptTokens: 120,
      completionTokens: 34,
      totalTokens: 154,
    });
  });
});
