import http from "node:http";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encodeTraceRequest, decodeTraceProtobuf } from "../src/otlp/codec.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, s, span, toolSpan, until } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function served(noEngine = true) {
  const tb = await makeRoots({ serve: true, noEngine });
  cleanup.push(tb.close);
  return tb;
}

function sampleRun() {
  const t = hex(16);
  const root = hex(8);
  return {
    t,
    root,
    batches: [
      batch([
        llmSpan(t, root, { system: "sys", user: "Email me at jane.doe@example.com", out: "ok", toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }] }),
        toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', '{"owner":"jane.doe@example.com","phone":"415-555-0134"}'),
        span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.session.id", "s1"), { key: "big", value: { intValue: "9007199254740993" } }] }),
      ]),
    ],
  };
}

describe("server", () => {
  it("accepts gzip protobuf OTLP like the SDKs send, and answers with a protobuf response", async () => {
    const tb = await served();
    const { t, batches } = sampleRun();
    const res = await fetch(`${tb.url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip", "x-api-key": "anything" },
      body: zlib.gzipSync(encodeTraceRequest(batches)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("protobuf");
    expect(tb.roots.store.getRun(t)?.span_count).toBe(3);
    const json = await fetch(`${tb.url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(json.status).toBe(400);
  });

  it("refuses foreign Host headers and cross-origin API calls, but allows OTLP from browsers", async () => {
    const tb = await served();
    const evilStatus = await new Promise<number>((resolve) => {
      const u = new URL(`${tb.url}/api/status`);
      http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(evilStatus).toBe(403);
    const xorigin = await fetch(`${tb.url}/api/settings`, { method: "POST", headers: { origin: "https://evil.example.com", "content-type": "application/json" }, body: JSON.stringify({ cloud_endpoint: "https://evil.example.com" }) });
    expect(xorigin.status).toBe(403);
    const same = await fetch(`${tb.url}/api/status`, { headers: { origin: tb.url.replace("127.0.0.1", "localhost") } });
    expect(same.status).toBe(200);
    const pre = await fetch(`${tb.url}/v1/traces`, { method: "OPTIONS", headers: { origin: "https://app.example.com" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const bad = await fetch(`${tb.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cloud_endpoint: "https://evil.example.com" }) });
    expect(bad.status).toBe(400);
  });

  it("forwards runs to an OTLP endpoint losslessly, redacted, with a completion marker and findings", async () => {
    const source = await served();
    const sink = await served();
    const { t, root, batches } = sampleRun();
    source.roots.ingest(batches);
    source.roots.store.insertFinding({ trace_id: t, check_id: "repeated-tool-call", check_kind: "rule", title: "Repeated", probability: null, status: "raised", evidence_span_ids: [root], detail: {}, model: null, triage_score: null, explanation_id: null });
    const preview = await source.roots.relay.preview([t]);
    expect(preview.redactions.find((r) => r.kind === "email")?.count).toBe(2);
    expect(preview.redactions.find((r) => r.kind === "phone")?.count).toBe(1);
    const row = await source.roots.relay.forward([t], "test", { endpoint: sink.url, apiKey: "nl-test-key" });
    expect(row.status).toBe("ok");
    expect(row.redactions).toBe(3);
    const run = await until(() => sink.roots.store.getRun(t));
    expect(run.span_count).toBe(3);
    expect(run.complete).toBe(1);
    const original = batches[0].spans.find((x) => x.spanId === root)!;
    const [got] = sink.roots.store.batchesForTraces([t]).flatMap((b) => b.spans.filter((x) => x.spanId === root));
    expect(got.startTimeUnixNano).toBe(original.startTimeUnixNano);
    expect(got.attributes.find((a) => a.key === "big")?.value).toEqual({ intValue: "9007199254740993" });
    expect(got.attributes.find((a) => a.key === "neatroots.findings.count")?.value).toEqual({ intValue: "1" });
    const tool = sink.roots.store.batchesForTraces([t]).flatMap((b) => b.spans).find((x) => x.name === "lookup_order")!;
    const out = tool.attributes.find((a) => a.key === "neatlogs.tool.output")!.value as { stringValue: string };
    expect(out.stringValue).toContain("[redacted:email]");
    expect(out.stringValue).not.toContain("jane.doe");
    expect(source.roots.store.forwardedTraceIds().has(t)).toBe(true);
    // the encoded request is valid OTLP for any collector
    const enc = source.roots.relay.encode([t]);
    expect(decodeTraceProtobuf(enc.main).flatMap((b) => b.spans)).toHaveLength(3);
    expect(decodeTraceProtobuf(enc.markers!).flatMap((b) => b.spans)[0].name).toBe("neatlogs.trace.complete");
  });

  it("serves MCP tools over streamable HTTP", async () => {
    const tb = await served();
    const { t, batches } = sampleRun();
    tb.roots.ingest(batches);
    tb.roots.ingest([batch([markerSpan(t, batches[0].spans[2].spanId)])]);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
    const tools = await client.listTools();
    const names = tools.tools.map((x) => x.name);
    for (const n of ["get_current_run", "search_runs", "get_run_outline", "get_span", "list_findings", "explain_run", "ask", "judge", "create_check", "preview_check", "annotate", "rerun", "push_to_cloud"]) expect(names).toContain(n);
    const text = (r: any) => JSON.parse(r.content[0].text);
    const search = text(await client.callTool({ name: "search_runs", arguments: { text: "4512" } }));
    expect(search.runs[0].trace_id).toBe(t);
    const outline = text(await client.callTool({ name: "get_run_outline", arguments: { trace_id: t.slice(0, 10) } }));
    expect(outline.outline).toContain("lookup_order");
    const toolId = batches[0].spans[1].spanId;
    const sp = text(await client.callTool({ name: "get_span", arguments: { trace_id: t, span_id: toolId.slice(0, 6), path: "$.output.owner" } }));
    expect(sp.value).toBe("jane.doe@example.com");
    const draft = text(await client.callTool({ name: "create_check", arguments: { check: "id: my-check\nkind: yes_no\nask: Did the agent do something bad here?\n", save: false } }));
    expect(draft.saved).toBe(false);
    const ann = text(await client.callTool({ name: "annotate", arguments: { trace_id: t, label: "issue", text: "wrong order" } }));
    expect(ann.label).toBe("issue");
    const push = text(await client.callTool({ name: "push_to_cloud", arguments: { trace_ids: [t] } }));
    expect(push.status).toBe("awaiting_confirmation");
    expect(tb.roots.pushes.get(push.push_id)?.status).toBe("pending");
    const err = await client.callTool({ name: "get_span", arguments: { span_id: "ffffff" } });
    expect(err.isError).toBe(true);
    await client.close();
  });

  it("answers steering claims for unknown runs with mode unknown", async () => {
    const tb = await served();
    const r = await fetch(`${tb.url}/api/steer/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trace_id: hex(16) }) });
    expect(await r.json()).toEqual({ mode: "unknown", known: false, note: null });
  });

  it("rejects trace_ids that aren't a list of run ids on the cloud routes, without storing anything", async () => {
    const tb = await served();
    const headers = { "content-type": "application/json", origin: tb.url.replace("127.0.0.1", "localhost") };
    const post = (path: string, trace_ids: unknown) => fetch(`${tb.url}${path}`, { method: "POST", headers, body: JSON.stringify({ trace_ids }) });
    for (const path of ["/api/cloud/preview", "/api/cloud/forward", "/api/cloud/import"]) {
      for (const bad of [{ length: 3 }, "notarray", [1, 2], [""], []]) {
        const r = await post(path, bad);
        expect(r.status, `${path} ${JSON.stringify(bad)}`).toBe(400); // preview was a 500 for an object, 200 for a string
        expect(((await r.json()) as { error: string }).error).toMatch(/trace_ids/);
      }
    }
    expect(tb.roots.store.listForwards(10)).toEqual([]); // forward used to save the bad value as a failed send
    // a real list still works
    const { t, batches } = sampleRun();
    tb.roots.ingest(batches);
    const ok = await post("/api/cloud/preview", [t]);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { span_count: number }).span_count).toBe(3);
  });

  it("clamps the findings list limit instead of failing on a bad value", async () => {
    const tb = await served();
    const { t, root, batches } = sampleRun();
    tb.roots.ingest(batches);
    for (let i = 0; i < 3; i++) tb.roots.store.insertFinding({ trace_id: t, check_id: `c${i}`, check_kind: "rule", title: `F${i}`, probability: null, status: "raised", evidence_span_ids: [root], detail: {}, model: null, triage_score: null, explanation_id: null });
    const origin = { origin: tb.url.replace("127.0.0.1", "localhost") };
    const count = async (limit: string) => {
      const r = await fetch(`${tb.url}/api/findings?limit=${limit}`, { headers: origin });
      expect(r.status).toBe(200); // was a 500 ("datatype mismatch") for limit=abc
      return ((await r.json()) as { findings: unknown[] }).findings.length;
    };
    expect(await count("abc")).toBe(3); // not a number: default limit
    expect(await count("-5")).toBe(1); // was every finding (SQLite LIMIT -1)
    expect(await count("0")).toBe(1); // was none
    expect(await count("2")).toBe(2);
  });

  it("returns 404 JSON for unknown /api and /v1 routes, not the SPA", async () => {
    const tb = await served();
    for (const path of ["/api/anything-unknown", "/api/imports/abc", "/v1/unknown"]) {
      const r = await fetch(`${tb.url}${path}`);
      expect(r.status).toBe(404);
      expect(r.headers.get("content-type")).toMatch(/application\/json/);
      expect(await r.json()).toEqual({ error: "not found" });
    }
    // a known API route still works, and non-API paths still fall back to the SPA
    expect((await fetch(`${tb.url}/api/status`, { headers: { origin: tb.url.replace("127.0.0.1", "localhost") } })).status).toBe(200);
    const ui = await fetch(`${tb.url}/runs/some-id`);
    expect(ui.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("gives a helpful error (not a raw fetch failure) when no LLM is reachable", async () => {
    const tb = await served(false); // engine on, but no LLM configured (dead base url)
    const r = await fetch(`${tb.url}/api/ask`, { method: "POST", headers: { "content-type": "application/json", origin: tb.url.replace("127.0.0.1", "localhost") }, body: JSON.stringify({ question: "what happened?" }) });
    expect(r.status).toBe(503);
    const msg = (await r.json()).error as string;
    expect(msg).toMatch(/No LLM is reachable/);
    expect(msg).toMatch(/Settings → Models|neatroots llm use/);
    expect(msg).not.toMatch(/fetch failed/);
  });
});
