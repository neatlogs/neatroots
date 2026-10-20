import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { batch, makeRoots, span } from "./helpers.js";

// Tools promise that "any unique prefix works". A prefix that matches more than one run or span
// must say so, never quietly hand the coding agent another run's data.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Close in reverse order: the MCP client before the server it is connected to.
  for (const c of cleanup.splice(0).reverse()) await c();
});

const A = "abcd1111" + "0".repeat(24);
const B = "abcd2222" + "0".repeat(24);

async function setup() {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  tb.roots.ingest([batch([span({ traceId: A, spanId: "aa11000000000000", name: "run-a", kind: "workflow" })])]);
  tb.roots.ingest([
    batch([
      span({ traceId: B, spanId: "bb22000000000000", name: "run-b", kind: "workflow" }),
      span({ traceId: B, spanId: "cc33000000000000", parent: "bb22000000000000", name: "first", kind: "tool" }),
      span({ traceId: B, spanId: "cc34000000000000", parent: "bb22000000000000", name: "second", kind: "tool" }),
    ]),
  ]);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return call;
}

describe("MCP id prefixes", () => {
  it("refuses a run prefix that matches more than one run, or a wildcard", async () => {
    const call = await setup();
    const amb = await call("get_run_outline", { trace_id: "abcd" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/matches more than one run/);
    expect(amb.text).toContain("abcd1111");
    expect(amb.text).toContain("abcd2222");
    for (const wild of ["%", "____1111"]) expect((await call("get_run_outline", { trace_id: wild })).isError).toBe(true);
    // a unique prefix and a full id still work
    expect((await call("get_run_outline", { trace_id: "abcd1" })).text).toContain("run-a");
    expect((await call("get_run_outline", { trace_id: B })).text).toContain("run-b");
  });

  it("refuses an ambiguous or empty span prefix", async () => {
    const call = await setup();
    const amb = await call("get_span", { trace_id: B, span_id: "cc3" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/matches more than one span/);
    expect((await call("get_span", { trace_id: B, span_id: "" })).isError).toBe(true);
    const one = await call("get_span", { trace_id: B, span_id: "cc34" });
    expect(one.isError).toBe(false);
    expect(one.text).toContain("second");
  });
});
