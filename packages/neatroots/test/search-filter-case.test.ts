import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// tool: and model: match any case when the search has text. Without text they matched only the
// exact case, so tool:lookuporder found nothing for a LookupOrder run.
describe("search tool: and model: filters", () => {
  it("match any case, with or without text", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const traceId = hex(16);
    const root = span({ traceId, name: "agent", kind: "workflow" });
    const llm = llmSpan(traceId, root.spanId, { user: "where is order 4512" });
    llm.attributes = [...llm.attributes.filter((a) => a.key !== "neatlogs.llm.model_name"), s("neatlogs.llm.model_name", "GPT-4o")];
    t.roots.ingest([batch([root, llm, toolSpan(traceId, root.spanId, "LookupOrder", "order 4512", "shipped")], "e2e")]);
    const total = async (q: string) => ((await (await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`)).json()) as { total: number }).total;
    for (const q of ["tool:lookuporder", "tool:LookupOrder", "tool:lookuporder order", "model:gpt-4o", "model:GPT-4o", "model:gpt-4o order"]) {
      expect(await total(q), q).toBe(1);
    }
    expect(await total("tool:refund")).toBe(0);
    expect(await total("model:claude")).toBe(0);
  });
});
