import http from "node:http";
import { spawnSync } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { httpTraceToBatches, HttpTraceError } from "../src/ingest/http-trace.js";
import { startGrpc } from "../src/ingest/grpc.js";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { buildSpan, toNs } from "../src/ingest/build.js";
import { encodeTraceRequest } from "../src/otlp/codec.js";
import { buildView } from "../src/semantics/view.js";
import { batch, freePort, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("Neatlogs HTTP trace API (POST /v1/trace)", () => {
  it("turns a nested trace into spans with kinds, tokens and timing", () => {
    const { batches, spans } = httpTraceToBatches({
      name: "support-chat",
      project: "web-app",
      session_id: "s1",
      children: [
        { name: "lookup", tool_name: "lookup_order", input: { id: 1 }, output: { ok: true }, duration_ms: 40 },
        { name: "answer", model: "gpt-4o", input: "Where is my order?", output: "Shipped.", tokens: { prompt: 20, completion: 3 }, duration_ms: 100 },
        { name: "check", passed: false, score: 0.2 },
      ],
    });
    expect(spans).toBe(4);
    const [root, tool, llm, guard] = batches[0].spans;
    expect(root.parentSpanId).toBe("");
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(buildView(tool, batches[0].resource.attributes)).toMatchObject({ kind: "TOOL", toolName: "lookup_order", input: { id: 1 } });
    expect(buildView(llm, [])).toMatchObject({ kind: "LLM", model: "gpt-4o", promptTokens: 20, completionTokens: 3, totalTokens: 23 });
    expect(buildView(guard, [])).toMatchObject({ kind: "GUARDRAIL" });
    expect(BigInt(llm.startTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(tool.endTimeUnixNano));
    expect(BigInt(root.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(llm.endTimeUnixNano));
    expect(buildView(root, batches[0].resource.attributes)).toMatchObject({ kind: "WORKFLOW", sessionId: "s1", workflow: "web-app" });
  });

  it("infers a node's kind in the documented order when it doesn't say", () => {
    const { batches } = httpTraceToBatches({
      name: "agent",
      children: [
        { name: "update_address", input: { order: "1001" }, status: "ERROR", error: "500" }, // a bare leaf is a tool
        { name: "plan", children: [{ name: "search" }] }, // a node with children is a chain
        { name: "summarize", tokens: { prompt: 10, completion: 2 } }, // tokens alone mean an LLM call
        { name: "toxicity", score: 0.1 }, // score alone means a guardrail
        { name: "call_api", tool_name: "weather", model: "gpt-4o" }, // tool_name wins over model
        { name: "step", kind: "AGENT" }, // an explicit kind always wins
      ],
    });
    const kinds = Object.fromEntries(batches[0].spans.map((sp) => [sp.name, buildView(sp, []).kind]));
    expect(kinds).toEqual({ agent: "WORKFLOW", update_address: "TOOL", plan: "CHAIN", search: "TOOL", summarize: "LLM", toxicity: "GUARDRAIL", call_api: "TOOL", step: "AGENT" });
  });

  it("rejects a malformed trace with field details", () => {
    expect(() => httpTraceToBatches({ children: [{ name: 3 }] })).toThrow(HttpTraceError);
    try {
      httpTraceToBatches({ children: [{}], status: "maybe" });
    } catch (e) {
      expect((e as HttpTraceError).details).toMatchObject({ name: "required", "children[0].name": "required", status: "must be OK or ERROR" });
    }
  });

  it("rejects a too-deeply-nested trace with a 400 instead of a stack overflow", () => {
    let node: { name: string; children?: unknown[] } = { name: "leaf" };
    for (let i = 0; i < 5000; i++) node = { name: `n${i}`, children: [node] };
    let caught: unknown;
    expect(() => {
      try {
        httpTraceToBatches(node);
      } catch (e) {
        caught = e;
        throw e;
      }
    }).toThrow(HttpTraceError); // a validation error, not RangeError: Maximum call stack size exceeded
    expect(JSON.stringify((caught as HttpTraceError).details)).toMatch(/nested too deep/);
    // a normal shallow trace is unaffected
    expect(httpTraceToBatches({ name: "root", children: [{ name: "child" }] }).spans).toBe(2);
  });

  it("rejects a non-finite duration_ms with a 400 instead of crashing (RangeError -> 500)", () => {
    for (const bad of [NaN, Infinity, -Infinity, "fast"]) {
      try {
        httpTraceToBatches({ name: "a", duration_ms: bad as number });
        throw new Error(`expected HttpTraceError for duration_ms=${String(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpTraceError);
        expect((e as HttpTraceError).details).toMatchObject({ duration_ms: "must be a finite number" });
      }
    }
    // A huge but finite duration_ms must not overflow BigInt and crash.
    expect(() => httpTraceToBatches({ name: "a", duration_ms: 1e308 })).not.toThrow();
    // The field error is reported with its path for nested nodes.
    try {
      httpTraceToBatches({ name: "root", children: [{ name: "child", duration_ms: NaN }] });
    } catch (e) {
      expect((e as HttpTraceError).details).toMatchObject({ "children[0].duration_ms": "must be a finite number" });
    }
  });

  it("rejects a non-finite score or token count instead of silently coercing it to null", () => {
    try {
      httpTraceToBatches({ name: "a", passed: true, score: NaN });
    } catch (e) {
      expect((e as HttpTraceError).details).toMatchObject({ score: "must be a finite number" });
    }
    try {
      httpTraceToBatches({ name: "a", model: "m", tokens: { prompt: NaN, total: Infinity } });
    } catch (e) {
      expect((e as HttpTraceError).details).toMatchObject({ "tokens.prompt": "must be a finite number", "tokens.total": "must be a finite number" });
    }
    // valid numbers are unaffected
    expect(httpTraceToBatches({ name: "a", passed: true, score: 0.9, model: "m", tokens: { prompt: 10, total: 15 } }).spans).toBe(1);
  });

  it("marks a guardrail that didn't pass as an error span", () => {
    const { batches } = httpTraceToBatches({
      name: "agent",
      children: [
        { name: "blocked", kind: "GUARDRAIL", passed: false, score: 0.97 },
        { name: "allowed", kind: "GUARDRAIL", passed: true, score: 0.02 },
        { name: "overridden", kind: "GUARDRAIL", passed: false, status: "OK" }, // an explicit status still wins
      ],
    });
    const status = Object.fromEntries(batches[0].spans.map((sp) => [sp.name, sp.status.code]));
    expect(status).toEqual({ agent: 1, blocked: 2, allowed: 1, overridden: 1 });
  });

  it("is served at /v1/trace and the run shows up", async () => {
    t = await makeRoots({ serve: true, noEngine: true });
    const res = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nlw_x" }, body: JSON.stringify({ name: "hello", project: "p1", input: "hi", output: "hey", children: [{ name: "llm", model: "m", input: "hi", output: "hey" }] }) });
    const body = (await res.json()) as { success: boolean; trace_id: string; spans: number };
    expect(body).toMatchObject({ success: true, spans: 2 });
    expect(t.roots.store.getRun(body.trace_id)).toMatchObject({ project: "p1", span_count: 2 });
    const bad = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    // A malformed duration_ms is a client error (400), not a server crash (500).
    const badDur = await fetch(`${t.url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"a","duration_ms":null}' });
    expect(badDur.status).toBe(400);
  });
});

describe("OTLP over gRPC", () => {
  it("keeps the server alive after an invalid compressed Export", async () => {
    const grpcPort = await freePort();
    const childSource = `
import * as grpc from "@grpc/grpc-js";
import http2 from "node:http2";
import { startGrpc } from "./src/ingest/grpc.js";
const grpcPort = __GRPC_PORT__;
const path = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";
let ingested = 0;
const roots = { config: { host: "127.0.0.1", grpcPort }, ingest: () => { ingested += 1; }, store: { ingestLogs: () => {} } };
const server = await startGrpc(roots);
if (!server) throw new Error("gRPC server did not start");
let session;
let client;
try {
  session = http2.connect("http://127.0.0.1:" + grpcPort);
  const stream = session.request({ ":method": "POST", ":path": path, "content-type": "application/grpc", te: "trailers", "grpc-encoding": "gzip" });
  const malformed = await new Promise(resolve => {
    let responseHeaders;
    let responseTrailers;
    let responseBodyBytes = 0;
    let streamError;
    let rstCode;
    let settled = false;
    const events = [];
    const finish = timedOut => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        httpStatus: responseHeaders?.[":status"],
        responseGrpcStatus: responseHeaders?.["grpc-status"],
        responseGrpcMessage: responseHeaders?.["grpc-message"],
        grpcStatus: responseTrailers?.["grpc-status"],
        grpcMessage: responseTrailers?.["grpc-message"],
        responseBodyBytes,
        streamError,
        rstCode,
        events,
        timedOut,
      });
    };
    const timer = setTimeout(() => finish(true), 1500);
    stream.on("response", headers => { responseHeaders = headers; events.push("response"); });
    stream.on("trailers", trailers => { responseTrailers = trailers; events.push("trailers"); });
    // Consume the response so trailers and end/close reflect the full server reply.
    stream.on("data", chunk => { responseBodyBytes += chunk.length; events.push("data"); });
    stream.on("end", () => { events.push("end"); });
    stream.on("aborted", () => { events.push("aborted"); });
    stream.on("close", () => { events.push("close"); rstCode = stream.rstCode; finish(false); });
    stream.on("error", error => { streamError = { name: error.name, code: error.code, message: error.message }; events.push("error"); });
    stream.end(Buffer.from([1, 0, 0, 0, 5, 0xde, 0xad, 0xbe, 0xef, 0x00]));
  });
  client = new grpc.Client("127.0.0.1:" + grpcPort, grpc.credentials.createInsecure());
  const healthy = await new Promise((resolve, reject) => {
    client.makeUnaryRequest(path, value => value, value => value, Buffer.alloc(0), new grpc.Metadata(), { deadline: new Date(Date.now() + 3000) }, error => error ? reject(error) : resolve(true));
  });
  if (ingested !== 1) throw new Error("healthy Export did not reach the OTLP handler");
  console.log(JSON.stringify({ malformed, healthy, ingested }));
} finally {
  session?.destroy();
  client?.close();
  server.forceShutdown();
}
`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource.replace("__GRPC_PORT__", String(grpcPort))], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 8000,
    });
    expect(child.error, child.stderr || "child process failed to start").toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.malformed.timedOut, JSON.stringify(result.malformed)).toBe(false);
    expect(result.malformed.events, JSON.stringify(result.malformed)).toContain("end");
    expect(result.malformed.httpStatus, JSON.stringify(result.malformed)).toBe(200);
    // Require rejection without assuming a particular grpc-js status mapping.
    const grpcStatus = result.malformed.grpcStatus ?? result.malformed.responseGrpcStatus;
    expect(grpcStatus, JSON.stringify(result.malformed)).toBeDefined();
    expect(String(grpcStatus), JSON.stringify(result.malformed)).not.toBe("0");
    expect(result.healthy).toBe(true);
    expect(result.ingested).toBe(1);
  }, 10_000);

  it("stores what an exporter sends to TraceService/Export", async () => {
    const grpcPort = await freePort();
    t = await makeRoots({ noEngine: true, config: (c) => (c.grpcPort = grpcPort) });
    const server = await startGrpc(t.roots);
    expect(server).toBeTruthy();
    const traceId = hex(16);
    const req = Buffer.from(encodeTraceRequest([batch([span({ traceId, name: "agent", kind: "workflow" })], "grpc-agent")]));
    const client = new grpc.Client(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
    await new Promise<void>((resolve, reject) =>
      client.makeUnaryRequest(
        "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
        (b: Buffer) => b,
        (b: Buffer) => b,
        req,
        new grpc.Metadata(),
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    client.close();
    server!.forceShutdown();
    expect(t.roots.store.getRun(traceId)).toMatchObject({ project: "grpc-agent" });
  });
});

describe("other conventions", () => {
  it("reads Vercel AI SDK spans", () => {
    const tid = hex(16);
    const llm = span({ traceId: tid, name: "ai.generateText.doGenerate", kind: "", attrs: [s("ai.operationId", "ai.generateText.doGenerate"), s("ai.model.id", "gpt-4o-mini"), s("ai.prompt.messages", JSON.stringify([{ role: "user", content: [{ type: "text", text: "Hi" }] }])), s("ai.response.text", "Hello"), s("ai.usage.promptTokens", 5)] });
    const v = buildView({ ...llm, attributes: llm.attributes.filter((a) => a.key !== "neatlogs.span.kind") }, []);
    expect(v).toMatchObject({ kind: "LLM", model: "gpt-4o-mini", promptTokens: 5, input: [{ role: "user", content: "Hi" }], output: [{ role: "assistant", content: "Hello" }] });
    const tool = span({ traceId: tid, name: "ai.toolCall", kind: "", attrs: [s("ai.operationId", "ai.toolCall"), s("ai.toolCall.name", "weather"), s("ai.toolCall.args", '{"city":"Paris"}'), s("ai.toolCall.result", '"sunny"')] });
    expect(buildView({ ...tool, attributes: tool.attributes.filter((a) => a.key !== "neatlogs.span.kind") }, [])).toMatchObject({ kind: "TOOL", toolName: "weather", input: { city: "Paris" }, output: "sunny" });
  });

  it("reads OpenTelemetry GenAI parts and OpenLLMetry entity input", () => {
    const tid = hex(16);
    const llm = span({ traceId: tid, name: "chat", kind: "", attrs: [s("gen_ai.operation.name", "chat"), s("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Q?" }] }]))] });
    expect(buildView({ ...llm, attributes: llm.attributes.filter((a) => a.key !== "neatlogs.span.kind") }, []).input).toEqual([{ role: "user", content: "Q?" }]);
    const wf = span({ traceId: tid, name: "plan.workflow", kind: "", attrs: [s("traceloop.span.kind", "workflow"), s("traceloop.entity.input", '{"q":1}')] });
    expect(buildView({ ...wf, attributes: wf.attributes.filter((a) => a.key !== "neatlogs.span.kind") }, [])).toMatchObject({ kind: "WORKFLOW", input: { q: 1 } });
  });
});

describe("imports", () => {
  it("parses ms, s, ns and ISO times", () => {
    expect(toNs(1_700_000_000_000)).toBe(1_700_000_000_000_000_000n);
    expect(toNs(1_700_000_000)).toBe(1_700_000_000_000_000_000n);
    expect(toNs("2026-10-09T10:00:00.123456789Z")).toBe(BigInt(Date.parse("2026-10-09T10:00:00.123Z")) * 1_000_000n + 456789n);
    expect(buildSpan({ traceId: "x", spanId: "y", name: "n", start: 1 }).traceId).toHaveLength(32);
  });

  it("reads an epoch with a fraction the same whether it's a number or a string", () => {
    // Python's str(time.time()) sends "1700000000.5"; it used to fall back to the arrival time.
    expect(toNs("1700000000.5")).toBe(toNs(1700000000.5));
    expect(BigInt(toNs("1700000000.5")!) / 1_000_000n).toBe(1_700_000_000_500n);
    expect(toNs("1700000000123.5")).toBe(toNs(1700000000123.5));
    const { batches } = httpTraceToBatches({ name: "run", start: "1700000000.25", end: "1700000001.75" });
    const sp = batches[0].spans[0];
    // Same as sending the numbers (which keep ns only to ~1 µs), not the arrival time.
    expect(sp.startTimeUnixNano).toBe(String(toNs(1700000000.25)));
    expect(sp.endTimeUnixNano).toBe(String(toNs(1700000001.75)));
    const off = BigInt(sp.startTimeUnixNano) - 1_700_000_000_250_000_000n;
    expect(off < 1000n && off > -1000n).toBe(true); // right to within a microsecond
    // strings that aren't times are still not read as times
    expect(toNs("abc")).toBeUndefined();
    expect(toNs(" 1700000000.5 ")).toBeUndefined();
  });

  it("reads OTLP JSON, Neatlogs exports and HTTP traces from files, one per line too", () => {
    const tid = hex(16);
    const otlp = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "f" } }] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId: tid, spanId: hex(8), name: "root", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", status: {} }] }] }] });
    expect(parseTraceFile(otlp, "trace.json")[0].spans[0].traceId).toBe(tid);
    const exp = JSON.stringify({ data: { schemaVersion: 1, trace: { traceId: tid, workflowName: "wf" }, spans: [{ traceId: tid, spanId: "1234567890abcdef", parentSpanId: null, spanName: "root", spanType: "workflow", startedAt: "2026-10-09T10:00:00Z", endedAt: null, durationMs: 5, status: "OK", model: null, provider: null, promptTokens: 0, completionTokens: 0, totalTokens: 0 }] } });
    expect(parseTraceFile(exp, "export.json")[0].spans[0].traceId).toBe(tid);
    const lines = `${JSON.stringify({ name: "a" })}\n${JSON.stringify({ name: "b", children: [{ name: "c" }] })}\n`;
    expect(parseTraceFile(lines, "traces.jsonl").map((b) => b.spans.length)).toEqual([1, 2]);
    expect(() => parseTraceFile('{"foo":1}', "x.json")).toThrow(/not OTLP JSON/);
  });

  it("imports a trace from Neatlogs Cloud with a service-account token and the chosen project", async () => {
    const tid = hex(16);
    const sid = hex(8);
    const seen: string[] = [];
    const cloud = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      // As the public API's OpenAPI spec says: Authorization: Bearer nlsa_…, x-project-id for the project.
      if (req.headers.authorization !== "Bearer nlsa_test_token" || req.headers["x-api-key"]) {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401 }));
        return;
      }
      seen.push(`${req.headers["x-project-id"]} ${req.url}`);
      if (req.url?.startsWith("/api/v1/public/projects")) {
        res.end(JSON.stringify({ success: true, requestId: "r", data: { projects: [{ id: "proj_1", name: "Production", orgId: "org", isDefault: true, isArchived: false }, { id: "proj_old", name: "Old", isArchived: true }], page: { hasMore: false, nextCursor: null, limit: 100 } } }));
      } else if (req.url?.startsWith(`/api/v1/public/traces/${tid}/export`)) {
        res.end(JSON.stringify({ success: true, requestId: "req_x", data: { schemaVersion: 1, trace: { traceId: tid, workflowName: "prod-agent", sessionId: "sess", startedAt: "2026-10-09T10:00:00Z" }, spans: [{ traceId: tid, spanId: sid, parentSpanId: null, spanName: "openai.chat", spanType: "llm", startedAt: "2026-10-09T10:00:00Z", endedAt: "2026-10-09T10:00:01Z", durationMs: 1000, status: "OK", model: "gpt-4o", provider: "openai", promptTokens: 4, completionTokens: 2, totalTokens: 6 }] } }));
      } else if (req.url?.includes(`/spans/${sid}/payload`)) {
        res.end(JSON.stringify({ success: true, requestId: "req_y", data: { traceId: tid, spanId: sid, fields: { input: { available: true, value: '[{"role":"user","content":"hi"}]', mimeType: "application/json", truncated: false }, output: { available: true, value: "hello", mimeType: null, truncated: false }, error: { available: false, value: null, mimeType: null, truncated: false } } } }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    const port = await freePort();
    await new Promise<void>((r) => cloud.listen(port, "127.0.0.1", r));
    t = await makeRoots({
      noEngine: true,
      serve: true,
      config: (c) => {
        c.cloud.apiBase = `http://127.0.0.1:${port}/api/v1/public`;
        c.cloud.projectId = "proj_1";
      },
    });
    try {
      // No token yet: a sentence about what to add, not a request with the wrong credential.
      process.env.NEATLOGS_CLOUD_API_KEY = "nl_project_key";
      const missing = await t.roots.imports.start("neatlogs-cloud", { traceIds: tid }, { limit: 1 }).done;
      expect(missing).toMatchObject({ state: "failed" });
      expect(missing.last_error).toMatch(/service-account token/);
      expect(seen).toEqual([]);

      process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_test_token";
      const projects = (await (await fetch(`${t.url}/api/cloud/projects`)).json()) as { projects: { id: string }[] };
      expect(projects.projects.map((p) => p.id)).toEqual(["proj_1"]);
      const job = await t.roots.imports.start("neatlogs-cloud", { traceIds: tid }, { limit: 1 }).done;
      expect(job).toMatchObject({ state: "succeeded", traces: 1, spans: 1 });
      expect(seen.filter((x) => x.includes("/traces/")).every((x) => x.startsWith("proj_1 "))).toBe(true);
      const run = t.roots.store.getRun(tid)!;
      expect(run).toMatchObject({ project: "prod-agent", session_id: "sess", llm_calls: 1 });
      const s1 = t.roots.store.getOtlpSpan(tid, sid)!;
      expect(buildView(s1.span, s1.resource.attributes)).toMatchObject({ model: "gpt-4o", input: [{ role: "user", content: "hi" }], output: "hello" });

      process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_wrong";
      const refused = await t.roots.imports.start("neatlogs-cloud", { traceIds: hex(16) }, { limit: 1 }).done;
      expect(refused.last_error).toMatch(/didn't accept the service-account token \(401\)/);
    } finally {
      delete process.env.NEATLOGS_CLOUD_API_KEY;
      delete process.env.NEATLOGS_SERVICE_TOKEN;
      cloud.close();
    }
  });

  it("keeps importing the other Neatlogs Cloud traces when one of them fails", async () => {
    const ids = [hex(16), hex(16), hex(16)];
    let exportCalls = 0;
    const cloud = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer nlsa_test_token") {
        res.statusCode = 401;
        res.end("{}");
        return;
      }
      if (req.url?.includes("/export")) exportCalls += 1;
      const i = ids.findIndex((id) => req.url?.startsWith(`/api/v1/public/traces/${id}/export`));
      if (i === 1) {
        res.statusCode = 500; // one trace the cloud can't export right now
        res.end('{"error":"boom"}');
      } else if (i >= 0) {
        const id = ids[i];
        res.end(JSON.stringify({ success: true, data: { schemaVersion: 1, trace: { traceId: id, workflowName: "prod-agent", startedAt: "2026-10-09T10:00:00Z" }, spans: [{ traceId: id, spanId: hex(8), parentSpanId: null, spanName: "root", spanType: "workflow", startedAt: "2026-10-09T10:00:00Z", endedAt: "2026-10-09T10:00:01Z", durationMs: 1000, status: "OK" }] } }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    const port = await freePort();
    await new Promise<void>((r) => cloud.listen(port, "127.0.0.1", r));
    t = await makeRoots({
      noEngine: true,
      config: (c) => {
        c.cloud.apiBase = `http://127.0.0.1:${port}/api/v1/public`;
        c.cloud.projectId = "proj_1";
      },
    });
    try {
      process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_test_token";
      const job = await t.roots.imports.start("neatlogs-cloud", { traceIds: ids.join(",") }, { limit: 3 }).done;
      // was: state "failed", traces 1, failed 0, and the third trace never fetched
      expect(job).toMatchObject({ state: "succeeded", traces: 2, failed: 1 });
      expect(job.last_error).toContain(ids[1]);
      expect(t.roots.store.getRun(ids[0])).toBeDefined();
      expect(t.roots.store.getRun(ids[2])).toBeDefined();
      // a token problem would fail every trace the same way, so it still stops at once
      process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_wrong";
      const refused = await t.roots.imports.start("neatlogs-cloud", { traceIds: ids.join(",") }, { limit: 3 }).done;
      expect(refused).toMatchObject({ state: "failed", traces: 0 });
      expect(refused.last_error).toMatch(/\(401\)/);
      // a cloud that fails every export is down, not one bad trace: stop after 3 in a row
      // instead of waiting out each trace's timeout
      process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_test_token";
      const unknown = Array.from({ length: 10 }, () => hex(16)); // the fake cloud answers 404 for each
      exportCalls = 0;
      const down = await t.roots.imports.start("neatlogs-cloud", { traceIds: unknown.join(",") }, { limit: 10 }).done;
      expect(down).toMatchObject({ state: "failed", traces: 0, failed: 3 });
      expect(down.last_error).toMatch(/3 traces in a row failed/);
      expect(exportCalls).toBe(3); // the other 7 were never requested
    } finally {
      delete process.env.NEATLOGS_SERVICE_TOKEN;
      cloud.close();
    }
  });
});
