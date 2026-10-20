import { afterEach, describe, expect, it } from "vitest";
import { parseSearch } from "../src/server/api-explore.js";
import { batch, hex, makeRoots, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// Search reads word:value as a filter only for the filters it knows. A URL or host:port someone
// pastes is text to find, not an unknown filter that empties the query and matches every run.
describe("search text with a colon in it", () => {
  it("keeps URLs and host:port as text, and still reads the known filters", () => {
    expect(parseSearch("localhost:8080")).toEqual({ text: "localhost:8080", filters: {} });
    expect(parseSearch("https://api.stripe.com/v1/charges")).toEqual({ text: "https://api.stripe.com/v1/charges", filters: {} });
    expect(parseSearch('project:support Status:failed "order 1001" localhost:8080')).toEqual({
      text: "order 1001 localhost:8080",
      filters: { project: "support", status: "failed" },
    });
  });

  it("finds only the run that mentions the address", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const run = (name: string, input: string, output: string) => {
      const traceId = hex(16);
      const root = span({ traceId, name, kind: "workflow" });
      t!.roots.ingest([batch([root, toolSpan(traceId, root.spanId, "http_get", input, output)], "e2e")]);
      return traceId;
    };
    const health = run("health", "http://localhost:8080/health", "connection refused");
    const stripe = run("stripe", "https://api.stripe.com/v1/charges", "ok");
    run("other", "order 1001", "shipped");
    const ids = async (q: string) =>
      ((await (await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`)).json()) as { runs: { trace_id: string }[] }).runs.map((r) => r.trace_id);
    expect(await ids("localhost:8080")).toEqual([health]);
    expect(await ids("https://api.stripe.com")).toEqual([stripe]);
  });
});
