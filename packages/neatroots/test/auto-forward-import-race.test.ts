import http from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeTraceProtobuf } from "../src/otlp/codec.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

const credentials = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("../src/relay/keychain.js", async (original) => ({
  ...await original<typeof import("../src/relay/keychain.js")>(), getCloudKey: credentials,
}));

let t: TestRoots | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  credentials.mockReset();
  await t?.close();
  t = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function setup() {
  const received: string[][] = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(decodeTraceProtobuf(gunzipSync(Buffer.concat(chunks))).flatMap(b => b.spans.map(s => s.name)));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t = await makeRoots({ noEngine: true, config: c => {
    c.cloud.endpoint = endpoint;
    c.projects["test-agent"] = { forward: true };
  } });
  credentials.mockResolvedValue("local-test-key");
  return { roots: t.roots, received };
}

for (const change of ["same-ID import", "delete and reimport", "unknown provenance", "deleted run"] as const) {
  it(`suppresses an automatic send after ${change} during credential lookup`, async () => {
    const { roots, received } = await setup();
    let release!: (key: string) => void;
    credentials.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    // Spy calls through: credentials alone are mocked; encoding and local HTTP are real.
    const forward = vi.spyOn(roots.relay, "forward");
    const traceId = hex(16);
    const source = batch([span({ traceId, name: "live-original", kind: "workflow" })]);
    roots.ingest([source]);
    await until(() => credentials.mock.calls.length === 1);
    if (change === "delete and reimport" || change === "deleted run") roots.store.deleteRun(traceId);
    if (change === "same-ID import" || change === "delete and reimport") {
      const imported = structuredClone(source);
      imported.spans[0].name = "private-imported-replacement";
      roots.ingest([imported], { importSource: "file" });
    } else if (change === "unknown provenance") {
      roots.store.db.prepare("INSERT INTO import_provenance_unknown (trace_id) VALUES (?)").run(traceId);
    }
    release("local-test-key");
    const result = await forward.mock.results[0].value;
    expect(received, `transmitted payloads: ${JSON.stringify(received)}`).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.span_count).toBe(0);
    expect(roots.store.forwardedTraceIds().has(traceId)).toBe(false);
  });
}

it("automatically sends live telemetry even with spoofed raw import attributes", async () => {
  const { roots, received } = await setup();
  const forward = vi.spyOn(roots.relay, "forward");
  const traceId = hex(16);
  const source = batch([span({ traceId, name: "live-control", kind: "workflow", attrs: [s("neatroots.import.source", "file")] })]);
  source.resource.attributes.push(s("neatroots.import.source", "registry"));
  roots.ingest([source]);
  await until(() => credentials.mock.calls.length === 1);
  const result = await forward.mock.results[0].value;
  expect(result.status).toBe("ok");
  expect(received.flat()).toContain("live-control");
  expect(roots.store.forwardedTraceIds().has(traceId)).toBe(true);
});

it("still permits explicit manual forwarding of imported telemetry", async () => {
  const { roots, received } = await setup();
  const traceId = hex(16);
  roots.ingest([batch([span({ traceId, name: "manual-import", kind: "workflow" })])], { importSource: "file" });
  const result = await roots.relay.forward([traceId], "user");
  expect(result.status).toBe("ok");
  expect(received.flat()).toContain("manual-import");
  expect(roots.store.forwardedTraceIds().has(traceId)).toBe(true);
});
