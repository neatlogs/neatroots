import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, makeRoots, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** One run per call: a workflow root with one tool call under it. */
function ingest(n: number, service: string, tool: string, input: string) {
  const batches = Array.from({ length: n }, () => {
    const traceId = hex(16);
    const root = span({ traceId, name: "agent", kind: "workflow" });
    return batch([root, toolSpan(traceId, root.spanId, tool, input, "done")], service);
  });
  t!.roots.ingest(batches);
}

const search = async (q: string) =>
  (await (await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}&limit=5`)).json()) as { total: number; runs: { trace_id: string; project: string; hits: unknown[] }[] };

// Search has to find every matching run, not only the newest 500 or the best-ranked 1000 spans.
describe("/api/search/runs over many runs", () => {
  it("finds a project whose runs are older than the newest 500", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    ingest(1, "billing", "lookup", '{"q":"invoice"}');
    ingest(500, "support", "lookup", '{"q":"ticket"}');
    const r = await search("project:billing");
    expect(r.total).toBe(1);
    expect(r.runs.map((x) => x.project)).toEqual(["billing"]);
  });

  it("counts every run that mentions the text, and reads tool: the same with or without it", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    ingest(1001, "support", "issue_refund", '{"reason":"refund requested"}');
    const r = await search("refund");
    expect(r.total).toBe(1001);
    expect(r.runs).toHaveLength(5);
    expect(r.runs.every((x) => x.hits.length > 0)).toBe(true);
    expect((await search("tool:Issue_Refund")).total).toBe(1001);
    expect((await search("tool:Issue_Refund refund")).total).toBe(1001);
  });
});

it("with text and tool:, matches only runs where that tool's own span has the text", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const run = (calls: [string, string][]) => {
    const traceId = hex(16);
    const root = span({ traceId, name: "agent", kind: "workflow" });
    t!.roots.ingest([batch([root, ...calls.map(([tool, input]) => toolSpan(traceId, root.spanId, tool, input, "done"))], "support")]);
    return traceId;
  };
  run([["issue_refund", '{"amount":40}'], ["lookup", '{"error":"timeout"}']]);
  const hit = run([["issue_refund", '{"error":"timeout"}']]);
  const r = await search("tool:issue_refund timeout");
  expect(r.total).toBe(1);
  expect(r.runs.map((x) => x.trace_id)).toEqual([hit]);
});
