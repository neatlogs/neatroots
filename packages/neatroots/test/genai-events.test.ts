import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import * as grpc from "@grpc/grpc-js";
import { startGrpc } from "../src/ingest/grpc.js";
import { Store } from "../src/store/db.js";
import { buildView } from "../src/semantics/view.js";
import { loadTrace, buildEvidence } from "../src/engine/trace.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { decodeLogsJson, encodeTraceRequest } from "../src/otlp/codec.js";
import { plainToAny, type Plain, type OtlpSpan } from "../src/otlp/types.js";
import { toChat } from "../src/replay/replay.js";
import { batch, freePort, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
const kv = (key: string, value: Plain) => ({ key, value: plainToAny(value) });
const event = (name: string, body: Record<string, Plain>, time = "100") => ({ name, timeUnixNano: time, attributes: Object.entries(body).map(([k, v]) => kv(k, v)) });
const llm = (events: OtlpSpan["events"] = []) => span({ traceId: hex(16), name: "chat", kind: "llm", events });
function logs(sp: OtlpSpan, name: string, body: Plain, time = "200", extra = {}) {
  return { resourceLogs: [{ resource: { attributes: [s("service.name", "test-agent")] }, scopeLogs: [{ logRecords: [{ traceId: sp.traceId, spanId: sp.spanId, timeUnixNano: time, eventName: name, body: plainToAny(body), ...extra }] }] }] };
}
async function post(route: string, body: unknown) {
  const res = await fetch(t!.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

describe("GenAI event messages", () => {
  it("orders legacy input by nanoseconds and choices by index, retaining tool calls", () => {
    const sp = llm([
      event("gen_ai.user.message", { content: "question" }, "1000000000000000002"),
      event("gen_ai.system.message", { content: "instructions" }, "1000000000000000001"),
      event("gen_ai.assistant.message", { tool_calls: [{ id: "old", function: { name: "lookup", arguments: '{"x":1}' } }] }, "1000000000000000003"),
      event("gen_ai.tool.message", { content: "found", id: "old" }, "1000000000000000004"),
      event("gen_ai.choice", { index: 1, message: { content: "second" } }),
      event("gen_ai.choice", { index: 0, message: { content: "first", tool_calls: [{ id: "call", function: { name: "search", arguments: '{"q":"a"}' } }] } }),
    ]);
    const v = buildView(sp, []);
    expect(v.input).toMatchObject([{ role: "system", content: "instructions" }, { role: "user", content: "question" }, { role: "assistant", tool_calls: [{ name: "lookup", arguments: { x: 1 } }] }, { role: "tool", content: "found", tool_call_id: "old" }]);
    expect(v.output).toMatchObject([{ content: "first" }, { content: "second" }]);
    expect(v.toolCalls).toEqual([{ id: "call", name: "search", arguments: { q: "a" } }]);
    expect(toChat(v.input).map((m) => m.content).join("\n")).toContain("question");
  });

  it("reads pre-message content events and current operation details from JSON/structured attributes", () => {
    expect(buildView(llm([
      event("gen_ai.content.prompt", { "gen_ai.prompt": '[{"role":"user","content":"old prompt"}]' }),
      event("gen_ai.content.completion", { "gen_ai.completion": "old answer" }),
    ]), [])).toMatchObject({ input: [{ role: "user", content: "old prompt" }], output: [{ role: "assistant", content: "old answer" }] });
    expect(buildView(llm([event("gen_ai.client.inference.operation.details", {
      "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "new prompt" }] }]),
      "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "lookup", arguments: { x: 2 } }] }],
    })]), [])).toMatchObject({ input: [{ role: "user", content: "new prompt" }], output: [{ role: "assistant", tool_calls: [{ id: "c", name: "lookup", arguments: { x: 2 } }] }] });
  });

  it("falls back independently for each direction and preserves existing attribute dialects", () => {
    const sp = llm([event("gen_ai.user.message", { content: "event prompt" }), event("gen_ai.choice", { message: { content: "event answer" } })]);
    sp.attributes.push(s("input.value", "attribute prompt"));
    expect(buildView(sp, [])).toMatchObject({ input: "attribute prompt", output: [{ content: "event answer" }] });
    sp.attributes.push(s("gen_ai.output.messages", '[{"role":"assistant","content":"attribute answer"}]'));
    expect(buildView(sp, []).output).toEqual([{ role: "assistant", content: "attribute answer" }]);
    sp.attributes.push(s("neatlogs.llm.input_messages.0.role", "user"), s("neatlogs.llm.input_messages.0.content", "neatlogs prompt"));
    expect(buildView(sp, []).input).toEqual([{ role: "user", content: "neatlogs prompt" }]);
  });

  it("leaves opaque generic outputs with malformed tool calls readable and lossless", () => {
    const sp = llm();
    const output = [{ role: "assistant", tool_calls: [null, 7, "bad", [], true] }];
    sp.attributes.push(kv("output.value", output));
    const raw = structuredClone(sp);
    expect(buildView(sp, []).output).toEqual(output);
    expect(buildView(sp, []).toolCalls).toBeUndefined();
    expect(sp).toEqual(raw);
  });

  it.each([true, false])("joins logs arriving before span: %s across HTTP, chat, search, evidence and raw export", async (before) => {
    t = await makeRoots({ serve: true, noEngine: true });
    const sp = llm([event("gen_ai.user.message", { content: "uniquequestion" }, "100")]);
    const raw = encodeTraceRequest([batch([sp])]);
    const system = logs(sp, "gen_ai.system.message", { content: "terse" }, "50");
    if (before) await post("/v1/logs", system);
    const sent = await fetch(t.url + "/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: raw });
    expect(sent.status).toBe(200);
    const initial = loadTrace(t.roots.store, sp.traceId);
    const seq = initial.spans[0].seq;
    if (!before) await post("/v1/logs", system);
    const updates: unknown[] = [];
    const off = t.roots.bus.on("trace", (u) => updates.push(u));
    const choice = logs(sp, "gen_ai.choice", { index: 0, message: { content: "uniqueanswer" } });
    await post("/v1/logs", choice);
    const snap = loadTrace(t.roots.store, sp.traceId);
    expect(snap.spans[0].input).toEqual([{ content: "terse", role: "system" }, { content: "uniquequestion", role: "user" }]);
    expect(snap.spans[0].seq).toBeGreaterThan(seq);
    expect(snap.run).toMatchObject({ input_preview: "uniquequestion", output_preview: "assistant: uniqueanswer", llm_calls: 1 });
    expect(buildChat(snap).items).toMatchObject([{ type: "system", text: "terse" }, { type: "user", text: "uniquequestion" }, { type: "assistant", text: "uniqueanswer" }]);
    expect(buildEvidence(snap).text).toContain("uniqueanswer");
    expect(t.roots.store.listRuns({ search: "uniqueanswer" }).map((r) => r.trace_id)).toContain(sp.traceId);
    expect(t.roots.store.getOtlpSpan(sp.traceId, sp.spanId)!.span).toEqual(sp);
    const response = await fetch(`${t.url}/api/runs/${sp.traceId}/chat`);
    expect((await response.json()).items).toHaveLength(3);
    expect(updates).toHaveLength(1);
    await post("/v1/logs", choice); // exporter retry stores its raw log, but changes no derived evidence
    expect(updates).toHaveLength(1);
    expect(loadTrace(t.roots.store, sp.traceId).spans[0].seq).toBe(snap.spans[0].seq);
    off();
  });

  it("keeps eventName/event.name and isolates trace, span and resource owners", async () => {
    t = await makeRoots({ noEngine: true });
    const sp = llm(); t.roots.ingest([batch([sp])]);
    const records = decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "correct" }));
    expect(records[0].eventName).toBe("gen_ai.user.message");
    t.roots.ingestLogs([
      { ...records[0], traceId: hex(16) }, { ...records[0], spanId: hex(8) },
      { ...records[0], resource: { attributes: [s("service.name", "other-tenant")] } },
    ]);
    expect(loadTrace(t.roots.store, sp.traceId).spans[0].input).toBeUndefined();
    t.roots.ingestLogs([{ ...records[0], eventName: undefined, attributes: [s("event.name", "gen_ai.user.message")] }]);
    expect(loadTrace(t.roots.store, sp.traceId).spans[0].input).toMatchObject([{ content: "correct" }]);
    expect(t.roots.store.db.prepare("SELECT event_name FROM logs ORDER BY id DESC LIMIT 1").get()).toEqual({ event_name: "gen_ai.user.message" });
  });

  it("keeps distinct repeated span messages and rejects explicit tenant mismatch", async () => {
    const sp = llm([event("gen_ai.user.message", { content: "again" }), event("gen_ai.user.message", { content: "again" })]);
    expect(buildView(sp, []).input).toHaveLength(2);
    t = await makeRoots({ noEngine: true });
    const b = batch([sp]); b.resource.attributes.push(s("tenant.id", "owner"));
    t.roots.ingest([b]);
    const record = decodeLogsJson(logs(sp, "gen_ai.choice", { message: { content: "private" } }))[0];
    record.resource.attributes.push(s("tenant.id", "other"));
    t.roots.ingestLogs([record]);
    expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.output).toBeUndefined();
  });

  it("does not emit an evidence update for irrelevant logs or attribute-shadowed messages", async () => {
    t = await makeRoots({ noEngine: true });
    const sp = llm(); sp.attributes.push(s("input.value", "authoritative")); t.roots.ingest([batch([sp])]);
    const received = vi.fn(); t.roots.bus.on("trace", received);
    t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "shadowed" })));
    t.roots.ingestLogs(decodeLogsJson(logs(sp, "exception", { content: "irrelevant" })));
    expect(received).not.toHaveBeenCalled();
  });

  it("correlates current structured operation-details protobuf logs over gRPC", async () => {
    const port = await freePort();
    t = await makeRoots({ noEngine: true, config: (c) => { c.grpcPort = port; } });
    const server = await startGrpc(t.roots);
    const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    try {
      const sp = llm(); t.roots.ingest([batch([sp])]);
      const protoDir = fileURLToPath(new URL("../proto/", import.meta.url));
      const root = new protobuf.Root();
      root.resolvePath = (_origin, target) => path.join(protoDir, target);
      root.loadSync("opentelemetry/proto/collector/logs/v1/logs_service.proto");
      const req = logs(sp, "gen_ai.client.inference.operation.details", {}, "300", { attributes: [
        kv("gen_ai.input.messages", [{ role: "user", parts: [{ type: "text", content: "grpc question" }] }]),
        kv("gen_ai.output.messages", [{ role: "assistant", parts: [{ type: "text", content: "grpc answer" }] }]),
      ] });
      const record = req.resourceLogs[0].scopeLogs[0].logRecords[0];
      const wire = { ...req, resourceLogs: [{ ...req.resourceLogs[0], scopeLogs: [{ logRecords: [{ ...record, traceId: Buffer.from(sp.traceId, "hex"), spanId: Buffer.from(sp.spanId, "hex") }] }] }] };
      const T = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
      const data = Buffer.from(T.encode(T.fromObject(wire)).finish());
      await new Promise<void>((resolve, reject) => client.makeUnaryRequest("/opentelemetry.proto.collector.logs.v1.LogsService/Export", (b: Buffer) => b, (b: Buffer) => b, data, new grpc.Metadata(), (err) => err ? reject(err) : resolve()));
      expect(loadTrace(t.roots.store, sp.traceId).spans[0]).toMatchObject({ input: [{ content: "grpc question" }], output: [{ content: "grpc answer" }] });
      expect(t.roots.store.db.prepare("SELECT event_name FROM logs WHERE trace_id = ?").get(sp.traceId)).toMatchObject({ event_name: "gen_ai.client.inference.operation.details" });
    } finally { client.close(); server?.forceShutdown(); }
  });

  it("migrates old logs and reads legacy event.name without modifying stored span content", async () => {
    t = await makeRoots({ noEngine: true });
    const sp = llm(); t.roots.ingest([batch([sp])]);
    t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.user.message", { content: "legacy question" }, "200", { attributes: [s("event.name", "gen_ai.user.message")] })));
    const dir = t.roots.store.dir;
    t.roots.store.db.exec("DROP INDEX logs_span_event; ALTER TABLE logs DROP COLUMN event_name");
    // A second Store exercises the same reopen/migration used on an existing installation.
    const reopened = new Store(dir);
    try {
      expect(reopened.spanView(sp.traceId, sp.spanId)?.input).toMatchObject([{ content: "legacy question" }]);
      expect(reopened.getOtlpSpan(sp.traceId, sp.spanId)!.span).toEqual(sp);
      expect(reopened.db.prepare("PRAGMA index_list(logs)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "logs_span_event" })]));
    } finally { reopened.close(); }
  });

  it("checks late content after run-end without ending the run again", async () => {
    t = await makeRoots();
    const sp = llm(); t.roots.ingest([batch([sp])]);
    await t.roots.engine!.waitIdle(sp.traceId, 5000);
    const run = t.roots.store.getRun(sp.traceId)!;
    const seq = t.roots.store.getSpans(sp.traceId)[0].seq;
    t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.choice", { message: { content: "sk-abcdefghijklmnopqrstuvwxyz123456" } })));
    await until(() => t!.roots.store.findingsForTrace(sp.traceId).some((f) => f.check_id === "secret-in-output"));
    await t.roots.engine!.waitIdle(sp.traceId, 5000);
    expect(t.roots.store.getRun(sp.traceId)).toMatchObject({ ended_ms: run.ended_ms, llm_calls: 1, span_count: 1 });
    expect(t.roots.store.getSpans(sp.traceId)[0].seq).toBeGreaterThan(seq);
    expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === "secret-in-output")).toHaveLength(1);
  });

  it("resolves and withdraws a disproven empty-output halt after completed-root logs arrive", async () => {
    t = await makeRoots();
    t.roots.steering.setMode("test-agent", "advisory");
    t.roots.checks.save({ id: "late-empty-output", kind: "rule", rule: { type: "run_end", when: "no_output" }, action: "halt", guidance: "Wait for an answer." }, "user");
    const sp = llm(); t.roots.ingest([batch([sp])]);
    const finding = await until(() => t!.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "late-empty-output"));
    expect(finding.status).toBe("raised");
    // A retained halt for this finding must also be withdrawn when its premise is disproven.
    t.roots.store.insertNote({ trace_id: sp.traceId, finding_id: finding.id, kind: "halt", text: "Wait for an answer.", status: "pending", checks: null });
    expect(t.roots.store.notesForTrace(sp.traceId).some((n) => n.finding_id === finding.id && n.kind === "halt")).toBe(true);
    t.roots.ingestLogs(decodeLogsJson(logs(sp, "gen_ai.choice", { message: { content: "An actual final answer." } })));
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    expect(t.roots.store.getFinding(finding.id)?.status).toBe("resolved");
    const preview = await t.roots.engine!.previewCheck({ id: "preview-empty", kind: "rule", rule: { type: "run_end", when: "no_output" } });
    expect(preview.checked).toBe(1);
    expect(preview.hits).toEqual([]);
    expect(t.roots.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "empty-final-answer")?.status).toBe("resolved");
    expect(t.roots.store.notesForTrace(sp.traceId).filter((n) => n.finding_id === finding.id && n.kind === "halt").every((n) => n.status === "expired")).toBe(true);
  });

  it("re-evaluates changed late content for trace and span checks without re-evaluating retries", async () => {
    t = await makeRoots();
    for (const scope of ["trace", "span"] as const) t.roots.checks.save({ id: `events-${scope}`, kind: "yes_no", ask: "Did the answer expose a secret?", scope, when: "live", flag_at: 0.5, evidence: { spans: { type: ["LLM"] } }, enabled: true }, "user");
    const decide = vi.spyOn(t.roots.decisions, "decide").mockImplementation(async (_e, qs) => ({ answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.01, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock" }) as never);
    const sp = llm(); sp.parentSpanId = hex(8);
    t.roots.ingest([batch([sp])]);
    await t.roots.engine!.waitIdle(sp.traceId, 5000);
    decide.mockClear();
    const records = decodeLogsJson(logs(sp, "gen_ai.choice", { message: { content: "latecontent" } }));
    t.roots.ingestLogs(records);
    await until(() => decide.mock.calls.some(([e]) => e.includes("latecontent")));
    await t.roots.engine!.waitIdle(sp.traceId, 5000);
    const calls = decide.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    t.roots.ingestLogs(records);
    await t.roots.engine!.waitIdle(sp.traceId, 5000);
    expect(decide).toHaveBeenCalledTimes(calls);
  });

  it.each(["trace", "span"] as const)("discards stale in-flight %s verdicts and checks the latest evidence once", async (scope) => {
    t = await makeRoots();
    const id = `inflight-${scope}`;
    t.roots.checks.save({ id, kind: "yes_no", ask: "Did the answer expose a secret?", scope, when: "live", flag_at: 0.5, evidence: { spans: { type: "LLM" }, fields: ["output"], goal: false }, enabled: true }, "user");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const decide = vi.spyOn(t.roots.decisions, "decide").mockImplementation(async (e, qs) => {
      if (qs[0].name === id && !e.includes("newestanswer")) await held;
      return { answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: e.includes("newestanswer") ? 0.01 : 0.99, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock", latencyMs: 1 } as never;
    });
    vi.spyOn(t.roots.decisions, "isSlow").mockResolvedValue(false);
    const sp = llm(); sp.parentSpanId = hex(8);
    t.roots.ingest([batch([sp])]);
    await until(() => decide.mock.calls.some(([, qs]) => qs[0].name === id));
    const records = decodeLogsJson(logs(sp, "gen_ai.choice", { message: { content: "newestanswer" } }));
    t.roots.ingestLogs(records);
    // Let the fresh update queue while the original decision is pending.
    await until(() => loadTrace(t!.roots.store, sp.traceId).spans[0].output !== undefined);
    release();
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    const asked = decide.mock.calls.filter(([, qs]) => qs[0].name === id);
    expect(asked).toHaveLength(2);
    expect(asked[1][0]).toContain("newestanswer");
    expect(t.roots.store.decisionsForTrace(sp.traceId).filter((d) => d.check_id === id)).toMatchObject([{ probability: 0.01 }]);
    expect(t.roots.store.findingsForTrace(sp.traceId).filter((f) => f.check_id === id)).toEqual([]);
    t.roots.ingestLogs(records);
    expect(await t.roots.engine!.waitIdle(sp.traceId, 5000)).toBe(true);
    expect(decide.mock.calls.filter(([, qs]) => qs[0].name === id)).toHaveLength(2);
  });
});
