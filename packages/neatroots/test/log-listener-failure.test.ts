import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { Bus } from "../src/bus.js";
import { decodeLogsJson } from "../src/otlp/codec.js";
import { plainToAny, type OtlpSpan } from "../src/otlp/types.js";
import { startGrpc } from "../src/ingest/grpc.js";
import { log } from "../src/util/log.js";
import { batch, freePort, hex, makeRoots, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
const llm = () => span({ traceId: hex(16), name: "chat", kind: "llm" });
function payload(spans: OtlpSpan[]) {
  return { resourceLogs: [{ resource: batch(spans).resource, scopeLogs: [{ logRecords: spans.map((sp) => ({ traceId: sp.traceId, spanId: sp.spanId, timeUnixNano: "100", eventName: "gen_ai.choice", body: plainToAny({ message: { content: "lateanswer" } }) })) }] }] };
}
function encode(spans: OtlpSpan[]) {
  const root = new protobuf.Root(), dir = fileURLToPath(new URL("../proto/", import.meta.url));
  root.resolvePath = (_o, target) => path.join(dir, target);
  root.loadSync("opentelemetry/proto/collector/logs/v1/logs_service.proto");
  const type = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
  const p = payload(spans);
  const records = p.resourceLogs[0].scopeLogs[0].logRecords.map((r) => ({ ...r, traceId: Buffer.from(r.traceId, "hex"), spanId: Buffer.from(r.spanId, "hex") }));
  return Buffer.from(type.encode(type.fromObject({ resourceLogs: [{ resource: p.resourceLogs[0].resource, scopeLogs: [{ logRecords: records }] }] })).finish());
}

it.each(["http", "grpc"] as const)("acknowledges committed %s logs despite failing trace/wildcard listeners, without exporter retry duplicates", async (transport) => {
  const port = await freePort();
  t = await makeRoots({ noEngine: true, serve: transport === "http", config: (c) => { c.grpcPort = port; } });
  await until(() => t!.roots.store.getMeta("search_index"));
  const spans = [llm(), llm()]; t.roots.ingest([batch(spans)]);
  const committed: boolean[] = [], notified: string[] = [], any: string[] = [];
  const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
  t.roots.bus.on("trace", () => {
    committed.push(!t!.roots.store.db.inTransaction && spans.every((s) => !!t!.roots.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(s.traceId)));
    throw new Error("private subscriber credential must stay local");
  });
  t.roots.bus.on("trace", (u) => notified.push(u.traceId));
  t.roots.bus.onAny(() => { throw new Error("private wildcard failure"); });
  t.roots.bus.onAny((u) => { if (u.event === "trace") any.push((u.payload as { traceId: string }).traceId); });
  const server = transport === "grpc" ? await startGrpc(t.roots) : undefined;
  const client = transport === "grpc" ? new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) : undefined;
  const send = async () => {
    if (client) return new Promise<{ status: number; body: string }>((resolve) => client.makeUnaryRequest("/opentelemetry.proto.collector.logs.v1.LogsService/Export", (b: Buffer) => b, (b: Buffer) => b, encode(spans), (err, body: Buffer) => resolve({ status: err?.code ?? 0, body: err?.details ?? body.toString() })));
    const response = await fetch(`${t!.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(spans)) });
    return { status: response.status, body: await response.text() };
  };
  try {
    const first = await send();
    // Model the exporter's one retry on the actual retryable transport response.
    if (first.status === (transport === "http" ? 503 : grpc.status.UNAVAILABLE)) await send();
    expect({ status: first.status, storedLogs: t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM logs").get(), notified, any, derived: spans.map((sp) => (t!.roots.store.spanView(sp.traceId, sp.spanId)?.output as unknown[])?.length) }).toEqual({ status: transport === "http" ? 200 : 0, storedLogs: { n: 2 }, notified: spans.map((s) => s.traceId), any: spans.map((s) => s.traceId), derived: [1, 1] });
    expect(committed).toEqual([true, true]);
    for (const sp of spans) {
      expect(t.roots.store.spanView(sp.traceId, sp.spanId)?.output).toEqual([{ role: "assistant", content: "lateanswer" }]);
      expect(t.roots.store.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
      expect(t.roots.store.getRun(sp.traceId)?.content_revision).toBe(1);
      expect(t.roots.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
    }
    expect(first.body).not.toContain("private");
    expect(warning).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
  } finally { client?.close(); server?.forceShutdown(); }
});

it("recovers durable checks after a rejected async notification and an actual store reopen", async () => {
  t = await makeRoots({ noEngine: true });
  await until(() => t!.roots.store.getMeta("search_index"));
  const sp = llm(); t.roots.ingest([batch([sp])]);
  t.roots.checks.save({ id: "listener-recovery", kind: "rule", rule: { type: "match", field: "output", pattern: "lateanswer" } }, "user");
  const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
  t.roots.bus.on("trace", async () => { throw new Error("private async failure"); });
  const other = vi.fn(); t.roots.bus.on("trace", other);
  expect(t.roots.ingestLogs(decodeLogsJson(payload([sp])))).toBe(1);
  await until(() => warning.mock.calls.length);
  expect(other).toHaveBeenCalledTimes(1);
  expect(t.roots.store.db.prepare("SELECT state FROM check_progress WHERE trace_id = ?").get(sp.traceId)).toEqual({ state: "checking" });
  const home = t.roots.home, config = t.roots.config; t.roots.close();
  const reopened = new Roots({ home, config });
  t = { ...t, roots: reopened, close: async () => { reopened.close(); fs.rmSync(home, { recursive: true, force: true }); } };
  vi.spyOn(reopened.decisions, "decide").mockImplementation(async (_e, qs) => ({ answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.01, distribution: { yes: 0.01, no: 0.99 } }])), backend: "mock", model: "mock", latencyMs: 1 }) as never);
  expect(reopened.engine!.progress.unfinished()).toContain(sp.traceId);
  await until(() => reopened.store.findingsForTrace(sp.traceId).find((f) => f.check_id === "listener-recovery"));
  await until(() => reopened.engine!.progress.state(sp.traceId) === undefined);
  expect(reopened.store.spanView(sp.traceId, sp.spanId)?.output).toHaveLength(1);
  expect(reopened.store.getOtlpSpan(sp.traceId, sp.spanId)?.span).toEqual(sp);
});

it("retains fail-fast behavior for ordinary bus emissions", () => {
  const bus = new Bus(), later = vi.fn();
  bus.on("settings", () => { throw new Error("ordinary failure"); }); bus.on("settings", later);
  expect(() => bus.emit("settings", {})).toThrow("ordinary failure"); expect(later).not.toHaveBeenCalled();
});
