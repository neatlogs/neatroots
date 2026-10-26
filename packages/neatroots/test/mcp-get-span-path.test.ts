import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { batch, llmSpan, makeRoots, span } from "./helpers.js";

// A JSONPath that matches nothing must say so, not fail the tool call.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Close in reverse order: the MCP client before the server it is connected to.
  for (const c of cleanup.splice(0).reverse()) await c();
});

const T = "a1b2c3d4" + "0".repeat(24);

async function setup() {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  const root = span({ traceId: T, spanId: "aa11000000000000", name: "run", kind: "workflow" });
  const llm = llmSpan(T, root.spanId, { system: "be nice", user: "hello", out: "world" });
  tb.roots.ingest([batch([root, llm])]);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { call, spanId: llm.spanId };
}

describe("MCP get_span JSONPath", () => {
  it("says a path matched nothing instead of crashing", async () => {
    const { call, spanId } = await setup();
    for (const path of ["$.nope", "$.input[99]", "$.attributes.missing"]) {
      const r = await call("get_span", { trace_id: T, span_id: spanId, path });
      expect(r.isError, `path ${path}: ${r.text}`).toBe(false);
      expect(r.text).toMatch(/matched nothing/);
    }
    // A wildcard that matches nothing still returns an empty list, as before.
    const star = await call("get_span", { trace_id: T, span_id: spanId, path: "$.input[*].bogus" });
    expect(star.isError).toBe(false);
    expect(star.text).toContain("[]");
    // A real path still returns its value.
    const hit = await call("get_span", { trace_id: T, span_id: spanId, path: "$.output" });
    expect(hit.isError).toBe(false);
    expect(hit.text).toContain("world");
  });
});
