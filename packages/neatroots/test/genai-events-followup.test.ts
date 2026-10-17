import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import * as grpc from "@grpc/grpc-js";
import { startGrpc } from "../src/ingest/grpc.js";
import { Roots } from "../src/core.js";
import { DecisionUnavailableError } from "../src/models/decision.js";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { plainToAny, type Plain, type OtlpSpan } from "../src/otlp/types.js";
import { batch, freePort, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
const kv = (key: string, value: Plain) => ({ key, value: plainToAny(value) });
const event = (name: string, body: Record<string, Plain>, time = "100") => ({ name, timeUnixNano: time, attributes: Object.entries(body).map(([k, v]) => kv(k, v)) });
const llm = () => span({ traceId: hex(16), name: "chat", kind: "llm" });
function logs(sp: OtlpSpan, name = "gen_ai.choice", body: Plain = { message: { content: "lateanswer" } }, extra = {}) {
  return { resourceLogs: [{ resource: { attributes: [s("service.name", "test-agent")] }, scopeLogs: [{ logRecords: [{ traceId: sp.traceId, spanId: sp.spanId, timeUnixNano: "100", eventName: name, body: plainToAny(body), ...extra }] }] }] };
}

it("preserves a dismissed run-end error when late content changes", async () => {
  t = await makeRoots();
  t.roots.checks.save({ id: "dismissed-error", kind: "rule", rule: { type: "run_end", when: "error" } }, "user");
  const sp = llm(); sp.status = { code: 2, message: "failed" };
  t.roots.ingest([batch([sp])]);
  const finding = await until(() => t!.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "dismissed-error"));
  await t.roots.engine!.waitIdle(sp.traceId, 5000);
  t.roots.store.updateFinding(finding.id, { status: "dismissed" });
  t.roots.ingestLogs(decodeLogsJson(logs(sp)));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "dismissed-error")).toMatchObject([{ id: finding.id, status: "dismissed" }]);
});

it("loads each raw span once for trace and detail, and reuses unchanged cached views", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const sp = llm(); t.roots.ingest([batch([sp])]);
  // Count request reads after the constructor's independent background reindex finishes.
  await until(() => t!.roots.store.getMeta("search_index"));
  const read = vi.spyOn(t.roots.store, "getOtlpSpan");
  loadTrace(t.roots.store, sp.traceId);
  expect(read).toHaveBeenCalledTimes(1);
  loadTrace(t.roots.store, sp.traceId);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockClear();
  expect((await fetch(`${t.url}/api/runs/${sp.traceId}/spans/${sp.spanId}`)).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(1);
});

it("does no derived-view or trace-wide reads for irrelevant logs, and uses event.name when eventName is empty", async () => {
  t = await makeRoots({ noEngine: true });
  const sp = llm(); t.roots.ingest([batch([sp])]);
  const views = vi.spyOn(t.roots.store, "spanView");
  const allSpans = vi.spyOn(t.roots.store, "getSpans");
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "exception", { content: "irrelevant" })));
  expect(views).not.toHaveBeenCalled();
  expect(allSpans).not.toHaveBeenCalled();
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "", { content: "fallbackname" }, { attributes: [s("event.name", "gen_ai.user.message")] })));
  expect(allSpans).not.toHaveBeenCalled();
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toMatchObject([{ content: "fallbackname" }]);
});

it.each(["gen_ai.user.message", "gen_ai.system.message"])("retains attribute content on bodyless %s HTTP logs", async (name) => {
  t = await makeRoots({ noEngine: true, serve: true });
  const sp = llm(); t.roots.ingest([batch([sp])]);
  const payload = logs(sp, name, null, { attributes: [s("content", "bodylessquestion")] });
  delete (payload.resourceLogs[0].scopeLogs[0].logRecords[0] as { body?: unknown }).body;
  const response = await fetch(`${t.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  expect(response.status).toBe(200);
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toMatchObject([{ content: "bodylessquestion" }]);
  expect(t.roots.store.listRuns({ search: "bodylessquestion" }).map((r) => r.trace_id)).toContain(sp.traceId);
});

it("backfills span/root previews and search on a reopened v2 database", async () => {
  t = await makeRoots({ noEngine: true });
  const sp = llm(); sp.events = [event("gen_ai.user.message", { content: "historicalquestion" }), event("gen_ai.choice", { message: { content: "historicalanswer" } })];
  t.roots.ingest([batch([sp])]);
  t.roots.store.db.exec("UPDATE spans SET input_preview = NULL, output_preview = NULL; UPDATE runs SET input_preview = NULL, output_preview = NULL; DELETE FROM span_fts");
  t.roots.store.setMeta("search_index", "2");
  const reopened = new Store(t.roots.store.dir);
  try {
    await new Promise<void>((resolve) => reopened.reindexSearch(() => resolve()));
    expect(reopened.getSpanRow(sp.traceId, sp.spanId)).toMatchObject({ input_preview: "user: historicalquestion", output_preview: "assistant: historicalanswer" });
    expect(reopened.getRun(sp.traceId)).toMatchObject({ input_preview: "historicalquestion", output_preview: "assistant: historicalanswer" });
    expect(reopened.listRuns({ search: "historicalanswer" }).map((r) => r.trace_id)).toContain(sp.traceId);
    expect(reopened.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
  } finally { reopened.close(); }
});

it("deduplicates canonical mirrored messages without collapsing distinct span events or times", async () => {
  t = await makeRoots({ noEngine: true });
  const sp = llm(); sp.events = [event("gen_ai.user.message", { role: "user", content: "mirror" })];
  t.roots.ingest([batch([sp])]);
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "mirror", role: "user" }, { attributes: [s("ancillary", "ignored")] })));
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toHaveLength(1);
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "mirror" }, { timeUnixNano: "101" })));
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toHaveLength(2);
  sp.events.push(sp.events[0]); t.roots.ingest([batch([sp])]);
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toHaveLength(3);
});

it("canonicalizes nested tool arguments and ancillary metadata while retaining distinct messages and tool IDs", async () => {
  t = await makeRoots({ noEngine: true });
  const sp = llm();
  sp.events = [event("gen_ai.assistant.message", { tool_calls: [{ id: "call-a", function: { name: "lookup", arguments: { a: 1, b: 2 } } }] })];
  t.roots.ingest([batch([sp])]);
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.assistant.message", { tool_calls: [{ function: { arguments: { b: 2, a: 1 }, name: "lookup" }, id: "call-a" }], ancillary: "ignored" })));
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toHaveLength(1);
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.assistant.message", { tool_calls: [{ id: "call-b", function: { name: "lookup", arguments: { a: 1, b: 2 } } }] })));
  const calls = t.roots.store.spanView(sp.traceId, sp.spanId)?.input as { tool_calls: { id: string }[] }[];
  expect(calls).toHaveLength(2);
  expect(calls.map((m) => m.tool_calls[0].id)).toEqual(["call-a", "call-b"]);
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "first" })));
  t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "second" })));
  expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.input).toMatchObject([{}, {}, { content: "first" }, { content: "second" }]);
});

it("honors persisted complete markers after live-run cleanup for late no-output and end questions", async () => {
  t = await makeRoots();
  t.roots.checks.save({ id: "end-content", kind: "yes_no", ask: "Is the output empty?", scope: "trace", when: "end", flag_at: 0.5 }, "user");
  const decide = vi.spyOn(t.roots.decisions, "decide").mockImplementation(async (_e, qs) => ({ answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.01, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock", latencyMs: 1 }) as never);
  const sp = llm(); t.roots.ingest([batch([sp])]);
  const empty = await until(() => t!.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "empty-final-answer"));
  await t.roots.engine!.waitIdle(sp.traceId, 5000);
  t.roots.store.db.prepare("UPDATE runs SET root_ended = 0, complete = 1 WHERE trace_id = ?").run(sp.traceId);
  (t.roots.engine as unknown as { live: Map<string, unknown> }).live.delete(sp.traceId);
  decide.mockClear();
  t.roots.ingestLogs(decodeLogsJson(logs(sp)));
  expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(t.roots.store.getFinding(empty.id)?.status).toBe("resolved");
  expect(decide.mock.calls.some(([e, qs]) => qs[0].name === "end-content" && e.includes("lateanswer"))).toBe(true);
  const current = new Set((t.roots.engine as unknown as { currentAnswers(id: string): { id: string }[] }).currentAnswers(sp.traceId).map((d) => d.id));
  expect(t.roots.engine!.progress.state(sp.traceId), JSON.stringify(t.roots.store.decisionsForTrace(sp.traceId).filter((d) => !current.has(d.id)).map((d) => ({ check: d.check_id, span: d.span_id, hash: d.evidence_hash })))).toBeUndefined();
});

it("returns retryable HTTP 503 for server ingestion errors and 400 for invalid log payloads", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  vi.spyOn(t.roots, "ingestLogs").mockImplementation(() => { throw new Error("SQLITE_BUSY test"); });
  const send = (body: string) => fetch(`${t!.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const failed = await send(JSON.stringify(logs(llm())));
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ code: 14 });
  expect((await send("{")).status).toBe(400);
});

it("returns retryable gRPC failure for ingestion errors but invalid argument for malformed protobuf", async () => {
  const port = await freePort(); t = await makeRoots({ noEngine: true, config: (c) => { c.grpcPort = port; } });
  const server = await startGrpc(t.roots);
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const send = (data: Buffer) => new Promise<grpc.ServiceError | null>((resolve) => client.makeUnaryRequest("/opentelemetry.proto.collector.logs.v1.LogsService/Export", (b: Buffer) => b, (b: Buffer) => b, data, (err) => resolve(err)));
  try {
    vi.spyOn(t.roots, "ingestLogs").mockImplementation(() => { throw new Error("SQLITE_BUSY test"); });
    const root = new protobuf.Root(); const dir = fileURLToPath(new URL("../proto/", import.meta.url)); root.resolvePath = (_o, target) => path.join(dir, target);
    root.loadSync("opentelemetry/proto/collector/logs/v1/logs_service.proto");
    const T = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
    expect((await send(Buffer.from(T.encode(T.create({})).finish())))?.code).toBe(grpc.status.UNAVAILABLE);
    expect((await send(Buffer.from([0x0a, 0xff])))?.code).toBe(grpc.status.INVALID_ARGUMENT);
  } finally { client.close(); server?.forceShutdown(); }
});

it.each([false, true])("does not reuse old verdicts after restart, unavailable model: %s", async (unavailable) => {
  t = await makeRoots({ noEngine: true });
  const id = "restart-evidence";
  t.roots.checks.save({ id, kind: "yes_no", ask: "Is the answer empty?", scope: "trace", when: "end", flag_at: 0.5 }, "user");
  const sp = llm(); t.roots.ingest([batch([sp])]);
  t.roots.store.insertDecision({ trace_id: sp.traceId, check_id: id, span_id: null, probability: 0.01, answer: null, backend: "mock", latency_ms: 1 });
  t.roots.ingestLogs(decodeLogsJson(logs(sp)));
  const home = t.roots.home, config = t.roots.config;
  t.roots.close();
  const reopened = new Roots({ home, config });
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } };
  const decide = vi.spyOn(reopened.decisions, "decide").mockImplementation(async (_e, qs) => ({ answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.01, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock", latencyMs: 1 }) as never);
  if (unavailable) decide.mockRejectedValue(new DecisionUnavailableError("mock unavailable"));
  expect(reopened.engine!.progress.unfinished()).toContain(sp.traceId);
  await reopened.engine!.recheck(sp.traceId, { resume: true });
  expect(await reopened.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
  expect(decide.mock.calls.some(([e, qs]) => qs[0].name === id && e.includes("lateanswer"))).toBe(true);
  expect(reopened.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === id)).toHaveLength(unavailable ? 1 : 2);
  expect(reopened.engine!.progress.state(sp.traceId)).toBe(unavailable ? "checking" : undefined);
});
