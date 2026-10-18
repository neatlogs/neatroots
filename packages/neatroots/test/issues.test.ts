import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodeTraceJson } from "../src/otlp/codec.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

// Bad input from outside (#11–#14): a buggy exporter or a script must get a clear error, and one
// odd trace must never break the run page.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function served(): Promise<TestRoots> {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  return tb;
}

const post = (url: string, path: string, body: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("spans whose parents point at each other (#11, #228)", () => {
  it("still serve the conversation, outline, and span context with each span listed once", async () => {
    const tb = await served();
    const t = hex(16);
    const [a, b] = [hex(8), hex(8)];
    tb.roots.ingest([batch([span({ traceId: t, spanId: a, parent: b, name: "agent-a", kind: "agent" }), span({ traceId: t, spanId: b, parent: a, name: "tool-b", kind: "tool" })])]);
    expect((await fetch(`${tb.url}/api/runs/${t}`)).status).toBe(200);
    const chat = await fetch(`${tb.url}/api/runs/${t}/chat`);
    expect(chat.status).toBe(200);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
    const r = (await client.callTool({ name: "get_run_outline", arguments: { trace_id: t } })) as { content: { text: string }[] };
    const outline = JSON.parse(r.content[0].text).outline as string;
    expect(outline.split("\n").filter((l) => l.includes("agent-a") || l.includes("tool-b"))).toHaveLength(2);

    const ctxA = (await client.callTool({ name: "get_span_context", arguments: { trace_id: t, span_id: a } })) as { content: { text: string }[] };
    const parsedCtxA = JSON.parse(ctxA.content[0].text) as { span: { name: string }; ancestors: { name: string }[] };
    expect(parsedCtxA.span.name).toBe("agent-a");
    expect(parsedCtxA.ancestors).toHaveLength(1);
    expect(parsedCtxA.ancestors[0].name).toBe("tool-b");

    const ctxB = (await client.callTool({ name: "get_span_context", arguments: { trace_id: t, span_id: b } })) as { content: { text: string }[] };
    const parsedCtxB = JSON.parse(ctxB.content[0].text) as { span: { name: string }; ancestors: { name: string }[] };
    expect(parsedCtxB.span.name).toBe("tool-b");
    expect(parsedCtxB.ancestors).toHaveLength(1);
    expect(parsedCtxB.ancestors[0].name).toBe("agent-a");

    await client.close();
  });
});

describe("request bodies that aren't a JSON object (#12)", () => {
  it("answer 400 with a message instead of a 500", async () => {
    const tb = await served();
    for (const raw of ["null", "[]", "5", '"x"', "{not json"]) {
      const r = await post(tb.url, "/api/settings", raw);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/JSON/);
    }
    // No body at all still reads as an empty one.
    expect((await fetch(`${tb.url}/api/settings`, { method: "POST" })).status).toBe(200);
  });
});

describe("OTLP JSON whose scopeSpans or spans isn't a list (#13)", () => {
  it("is rejected at every level instead of answering 200 and dropping it", async () => {
    const tb = await served();
    for (const body of [{ resourceSpans: [{ scopeSpans: "x" }] }, { resourceSpans: [{ scopeSpans: [{ spans: "y" }] }] }, { resourceSpans: ["z"] }]) {
      const r = await post(tb.url, "/v1/traces", JSON.stringify(body));
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe(3);
    }
    expect(() => decodeTraceJson({ resourceSpans: [{ scopeSpans: [{ spans: [] }] }] } as never)).not.toThrow();
  });
});

describe("spans without a proper end time (#14)", () => {
  it("a root sent before it ended keeps its run running; it finishes when the ended span arrives", async () => {
    const tb = await served();
    const t = hex(16);
    const root = hex(8);
    const open = span({ traceId: t, spanId: root, name: "agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...open, endTimeUnixNano: "0" }])]);
    const run = tb.roots.store.getRun(t)!;
    expect(run.status).toBe("running");
    expect(run.root_name).toBe("agent");
    expect(tb.roots.store.getSpans(t, false)[0].duration_ms).toBe(0);
    tb.roots.ingest([batch([open])]);
    expect(tb.roots.store.getRun(t)!.status).toBe("ok");
  });

  it("an end before the start never gives a negative duration", async () => {
    const tb = await served();
    const t = hex(16);
    const s = span({ traceId: t, name: "agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...s, endTimeUnixNano: (BigInt(s.startTimeUnixNano) - 5_000_000_000n).toString() }])]);
    const d = (await (await fetch(`${tb.url}/api/runs/${t}`)).json()) as { run: { duration_ms: number } };
    expect(d.run.duration_ms).toBe(0);
  });
});
