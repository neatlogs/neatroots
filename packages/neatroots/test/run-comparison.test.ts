import { afterEach, expect, it } from "vitest";
import { EXPLORE_TOOLS } from "../src/mcp/explore-tools.js";
import { compareRuns } from "../src/server/run-comparison.js";
import { batch, hex, llmSpan, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { await t?.close(); });

it("shares the HTTP and MCP comparison, preserves full output and chronological tool failures", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const a = hex(16), b = hex(16);
  const output = "original output ".repeat(200);
  const root = span({ traceId: a, name: "agent", kind: "workflow", attrs: [s("neatlogs.workflow.output", output)] });
  const first = toolSpan(a, root.spanId, "lookup", "{}", "ok");
  const last = toolSpan(a, root.spanId, "send", "{}", undefined, "failed");
  t.roots.ingest([batch([root, last, first, llmSpan(a, root.spanId, { user: "hello" })]), batch([span({ traceId: b, name: "agent", kind: "workflow" })])]);
  const result = compareRuns(t.roots, a, b);
  expect(result.a.tools).toEqual(["lookup", "send (failed)"]);
  expect(result.a.full_output).toBe(output);
  expect(result.a.output!.length).toBeLessThan(output.length);
  expect(result.a.reported_tokens).toBe(15);
  expect(result.b.reported_tokens).toBeNull();
  const response = await fetch(`${t.url}/api/compare?a=${a}&b=${b}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  const mcp = await EXPLORE_TOOLS.find((x) => x.name === "compare_runs")!.run(t.roots, { a, b });
  expect(mcp).toMatchObject({ a: { output: result.a.output, tools: result.a.tools }, same_tool_sequence: false });
  expect(mcp).not.toHaveProperty("a.full_output");
  expect(compareRuns(t.roots, a, a).same_tool_sequence).toBe(true);
});

it("compares every open finding including those beyond the default listing cap", async () => {
  t = await makeRoots({ noEngine: true });
  const a = hex(16), b = hex(16);
  t.roots.ingest([batch([span({ traceId: a, name: "agent", kind: "workflow" }), span({ traceId: b, name: "agent", kind: "workflow" })])]);
  const finding = (id: string, title: string, status: "raised" | "dismissed" = "raised") => t.roots.store.insertFinding({ trace_id: id, check_id: "test", check_kind: "rule", title, status, probability: null, evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  for (let i = 0; i < 210; i++) finding(a, `Problem ${i}`);
  finding(b, "Problem 209");
  finding(b, "New failure");
  finding(b, "Ignored", "dismissed");
  const result = compareRuns(t.roots, a, b);
  expect(result.a.problems).toHaveLength(210);
  expect(result.fixed).toHaveLength(209);
  expect(result.new_problems).toEqual(["New failure"]);
  expect(result.persistent).toEqual(["Problem 209"]);
  const mcp = await EXPLORE_TOOLS.find((x) => x.name === "compare_runs")!.run(t.roots, { a, b }) as { a: { problems: string[] }; fixed: string[] };
  expect(mcp.a.problems).toHaveLength(210);
  expect(mcp.fixed).toHaveLength(209);
});

it("marks stored output as a preview when the full root output is unavailable", async () => {
  t = await makeRoots({ noEngine: true });
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "agent", kind: "workflow" })])]);
  const preview = "Stored output shortened during ingestion…";
  t.roots.store.db.prepare("UPDATE runs SET output_preview = ? WHERE trace_id = ?").run(preview, traceId);

  const result = compareRuns(t.roots, traceId, traceId);
  expect(result.a.full_output).toBe(preview);
  expect(result.a.output_is_preview).toBe(true);
});

it("returns useful HTTP errors for absent selections and removed runs", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  expect((await fetch(`${t.url}/api/compare`)).status).toBe(400);
  expect((await fetch(`${t.url}/api/compare?a=missing&b=missing`)).status).toBe(404);
  expect(() => compareRuns(t.roots, "missing", "missing")).toThrow("run not found");
});
