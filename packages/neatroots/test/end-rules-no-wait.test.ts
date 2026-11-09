import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, mockLlm, s, span, toolSpan, until } from "./helpers.js";

// Rules need no model, so a slow local LLM must not hold back the ones that run at run end.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("end-of-run rules", () => {
  it("raise while the planner's LLM call is still running", async () => {
    const llm = await mockLlm({ delayMs: 3000 });
    cleanup.push(() => llm.close());
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(tb.close);
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([
      batch([
        llmSpan(t, root, { system: "You are a refund agent.", user: "Please refund order 1001." }),
        toolSpan(t, root, "issue_refund", '{"order_id":"1001"}', undefined, "payment gateway timeout"),
        span({ traceId: t, spanId: root, name: "support", kind: "workflow", attrs: [s("neatlogs.workflow.output", "Your refund has been processed successfully!")] }),
      ]),
    ]);
    const f = await until(() => tb.roots.store.findingsForTrace(t).find((x) => x.check_id === "unrecovered-tool-failure"), 1500);
    expect(f.status).toBe("raised");
    // The planner was asked and hasn't answered yet.
    expect(llm.requests.some((r) => r.response_format?.json_schema?.name === "plan")).toBe(true);
    expect(tb.roots.store.getRun(t)?.plan_id ?? null).toBeNull();
  });
});
