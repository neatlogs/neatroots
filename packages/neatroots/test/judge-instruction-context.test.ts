import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, makeRoots, mockLlm, s, span, toolSpan } from "./helpers.js";

const policy = "Never approve discount code SPECIAL_UNIQUE_4512.";
const request = "Apply the discount.";
const unselectedOutput = "UNSELECTED_TOOL_OUTPUT_9876";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(role: "system" | "developer", instruction = policy) {
  const llm = await mockLlm({});
  cleanup.push(llm.close);
  const tb = await makeRoots({ serve: true, llmUrl: llm.url });
  cleanup.push(tb.close);
  const traceId = hex(16);
  const root = span({ traceId, name: "discount-agent", kind: "workflow" });
  const call = span({ traceId, parent: root.spanId, name: "discount", kind: "llm", attrs: [
    s("neatlogs.llm.input_messages.0.role", role),
    s("neatlogs.llm.input_messages.0.content", instruction),
    s("neatlogs.llm.input_messages.1.role", "user"),
    s("neatlogs.llm.input_messages.1.content", request),
    s("neatlogs.llm.output_messages.0.role", "assistant"),
    s("neatlogs.llm.output_messages.0.content", "Discount approved."),
  ] });
  const tool = toolSpan(traceId, root.spanId, "lookup_discount", "{}", unselectedOutput);
  // Only explicit self-checks should reach the model, not automatic background checks.
  tb.roots.store.ingest([batch([root, call, tool])]);
  const judge = async (spanIds?: string[]) => {
    const response = await fetch(`${tb.url}/api/steer/check`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ trace_id: traceId, question: "Did the agent violate its instructions?", span_ids: spanIds }),
    });
    expect(response.status).toBe(200);
    return { result: await response.json() as { evidence_span_ids: string[] }, sent: JSON.stringify(llm.requests.at(-1)) };
  };
  return { call, tool, judge };
}

describe("self-check instruction context with selected spans", () => {
  for (const role of ["system", "developer"] as const) {
    it(`retains a single ${role} instruction when selecting the LLM call`, async () => {
      const { call, judge } = await setup(role);
      const whole = await judge();
      expect(whole.sent).toContain(policy);
      expect(whole.sent).toContain(unselectedOutput);
      const selected = await judge([call.spanId]);
      expect(selected.result.evidence_span_ids).toEqual([call.spanId]);
      expect(selected.sent).toContain(request);
      expect(selected.sent).not.toContain(unselectedOutput);
      expect(selected.sent).toContain(policy);
    });
  }

  it("retains the run's instructions when only a tool span is selected", async () => {
    const { tool, judge } = await setup("system");
    const selected = await judge([tool.spanId]);
    expect(selected.result.evidence_span_ids).toEqual([tool.spanId]);
    expect(selected.sent).toContain(unselectedOutput);
    expect(selected.sent).not.toContain("Discount approved.");
    expect(selected.sent).toContain(policy);
  });

  it("bounds the added instruction context like whole-run evidence", async () => {
    const { call, judge } = await setup("system", "x".repeat(1000) + " beyond-limit");
    const selected = await judge([call.spanId]);
    expect(selected.sent).toContain("x".repeat(899) + "…");
    expect(selected.sent).not.toContain("beyond-limit");
  });
});
