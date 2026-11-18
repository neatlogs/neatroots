import * as grpc from "@grpc/grpc-js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { startGrpc } from "../src/ingest/grpc.js";
import { decodeTraceJson, encodeTraceRequest } from "../src/otlp/codec.js";
import { freePort, hex, makeRoots, type TestRoots } from "./helpers.js";

// A batch that decoded but could not be stored (here: another connection holds the database's
// write lock) must get the answer an OTLP exporter retries: 503 over HTTP, UNAVAILABLE over gRPC.
// 400, 500 and INVALID_ARGUMENT all make it drop the batch.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

const now = String(BigInt(Date.now()) * 1_000_000n);
const traces = (traceId: string) => ({
  resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId, spanId: hex(8), name: "op", kind: 1, startTimeUnixNano: now, endTimeUnixNano: now, attributes: [] }] }] }],
});
const logs = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "x" }, logRecords: [{ timeUnixNano: now, body: { stringValue: "hi" }, attributes: [] }] }] }] };

async function setup(grpcPort?: number) {
  const tb = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.grpcPort = grpcPort ?? 0) });
  cleanup.push(() => tb.close());
  const db = (tb.roots.store as unknown as { db: Database.Database; file: string });
  db.db.pragma("busy_timeout = 100");
  const lock = () => {
    const other = new Database(db.file);
    other.prepare("BEGIN IMMEDIATE").run();
    return () => {
      other.prepare("ROLLBACK").run();
      other.close();
    };
  };
  return { tb, lock };
}

const post = (tb: TestRoots, path: string, body: unknown) =>
  fetch(`${tb.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a batch the store could not take", () => {
  it("is answered 503 on /v1/traces, and the same batch is stored when it is sent again", async () => {
    const { tb, lock } = await setup();
    const t = hex(16);
    const unlock = lock();
    const r = await post(tb, "/v1/traces", traces(t));
    unlock();
    expect(r.status).toBe(503); // was 500
    expect(tb.roots.store.getRun(t)).toBeUndefined();
    expect((await post(tb, "/v1/traces", traces(t))).status).toBe(200);
    expect(tb.roots.store.getRun(t)).toBeDefined();
  });

  it("is answered 503 on /v1/logs, while a payload that can't be read stays a 400", async () => {
    const { tb, lock } = await setup();
    const unlock = lock();
    const r = await post(tb, "/v1/logs", logs);
    unlock();
    expect(r.status).toBe(503); // was 400 "invalid OTLP logs payload"
    expect((await post(tb, "/v1/logs", { resourceLogs: "oops" })).status).toBe(400);
    expect((await post(tb, "/v1/logs", logs)).status).toBe(200);
  });

  it("is answered UNAVAILABLE over gRPC, while a message that can't be decoded stays INVALID_ARGUMENT", async () => {
    const port = await freePort();
    const { tb, lock } = await setup(port);
    const server = await startGrpc(tb.roots);
    cleanup.push(() => server?.forceShutdown());
    const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    cleanup.push(() => client.close());
    const send = (body: Buffer) =>
      new Promise<grpc.status>((resolve) =>
        client.makeUnaryRequest("/opentelemetry.proto.collector.trace.v1.TraceService/Export", (b: Buffer) => b, (b: Buffer) => b, body, (err) =>
          resolve(err ? err.code : grpc.status.OK),
        ),
      );
    const unlock = lock();
    const code = await send(Buffer.from(encodeTraceRequest(decodeTraceJson(traces(hex(16))))));
    unlock();
    expect(grpc.status[code]).toBe("UNAVAILABLE"); // was INVALID_ARGUMENT
    expect(grpc.status[await send(Buffer.from([0xff, 0xff, 0xff]))]).toBe("INVALID_ARGUMENT");
  });
});
