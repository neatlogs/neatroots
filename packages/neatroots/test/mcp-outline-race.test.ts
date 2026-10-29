import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { batch, hex, makeRoots, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  const ids = [hex(16), hex(16), hex(16)];
  for (const [i, traceId] of ids.entries()) {
    tb.roots.ingest([batch([span({ traceId, name: `run-${i}`, kind: "workflow" })])]);
  }
  tb.roots.focus = { trace_id: ids[0], span_id: hex(8), at: Date.now() };
  const client = new Client({ name: "outline-race-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!result.isError, text: result.content[0].text };
  };
  // Delete after the asynchronous projection read, before runDetail looks up the run.
  const readFlags = tb.roots.store.cancelledSpanIds.bind(tb.roots.store);
  const deleteDuringRead = (targets: string[]) => vi.spyOn(tb.roots.store, "cancelledSpanIds").mockImplementation(async (traceId) => {
    const flags = await readFlags(traceId);
    if (targets.includes(traceId)) tb.roots.store.deleteRun(traceId);
    return flags;
  });
  return { tb, ids, call, deleteDuringRead };
}

describe("MCP outlines when a run disappears during a read", () => {
  it.each(["get_current_run", "get_run_outline"])("%s retries with the latest run and explains the fallback", async (name) => {
    const { tb, ids, call, deleteDuringRead } = await setup();
    const reads = deleteDuringRead([ids[0]]);
    const result = await call(name);
    expect(result.isError).toBe(false);
    const value = JSON.parse(result.text);
    expect(value.run.trace_id).toBe(ids[2]);
    expect(value.outline).toContain("run-2");
    expect(value.note).toBe(`The run in focus (${ids[0].slice(0, 8)}…) was deleted; using the latest run.`);
    expect(tb.roots.focus).toBeNull();
    if (name === "get_current_run") expect(value.selected_span).toBeNull();
    expect(reads.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[2]]);
  });

  it.each(["get_current_run", "get_run_outline"])("%s stops after one retry if the replacement also disappears", async (name) => {
    const { ids, call, deleteDuringRead } = await setup();
    const reads = deleteDuringRead([ids[0], ids[2]]);
    const result = await call(name);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Error: run disappeared while reading outline");
    expect(reads.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[2]]);
  });

  it("does not substitute an unrelated run for an explicit trace id", async () => {
    const { ids, call, deleteDuringRead } = await setup();
    deleteDuringRead([ids[0]]);
    const result = await call("get_run_outline", { trace_id: ids[0] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`no run with id ${ids[0]}`);
  });
});
