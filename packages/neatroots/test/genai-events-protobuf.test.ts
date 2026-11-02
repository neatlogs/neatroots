import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import { afterEach, describe, expect, it } from "vitest";
import { decodeLogsProtobuf } from "../src/otlp/codec.js";
import { batch, closeTrackedStores, hex, tmpHome, trackedStore, s, span } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

// What real SDKs send: an OTLP/protobuf log record whose event_name (field 12) names a GenAI event.
function encode(traceId: string, spanId: string, eventName: string, content: string): Uint8Array {
  const dir = path.resolve(__dirname, "../proto");
  const root = new protobuf.Root();
  root.resolvePath = (_o, target) => (path.isAbsolute(target) ? target : path.join(dir, target));
  root.loadSync("opentelemetry/proto/collector/logs/v1/logs_service.proto", { keepCase: false });
  const T = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
  return T.encode(
    T.fromObject({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "app" } }] },
          scopeLogs: [
            {
              scope: { name: "app" },
              logRecords: [
                {
                  timeUnixNano: "5",
                  eventName,
                  traceId: Buffer.from(traceId, "hex"),
                  spanId: Buffer.from(spanId, "hex"),
                  body: { kvlistValue: { values: [{ key: "content", value: { stringValue: content } }] } },
                },
              ],
            },
          ],
        },
      ],
    }),
  ).finish();
}

describe("GenAI log events over protobuf", () => {
  it("keeps event_name when decoding, and the message reaches the stored span's view", () => {
    const traceId = hex(16);
    const spanId = hex(8);
    const [rec] = decodeLogsProtobuf(encode(traceId, spanId, "gen_ai.user.message", "hello from protobuf"));
    expect(rec.eventName).toBe("gen_ai.user.message");
    expect(rec.traceId).toBe(traceId);
    expect(rec.spanId).toBe(spanId);

    const home = tmpHome();
    homes.push(home);
    const st = trackedStore(path.join(home, "data"));
    const sp = span({ traceId, spanId, name: "chat gpt-4o", kind: "llm", attrs: [s("gen_ai.request.model", "gpt-4o")] });
    st.ingest([batch([sp])]);
    expect(JSON.stringify(st.viewOf({ span: sp, resource: { attributes: [] } }).input ?? "")).not.toContain("hello from protobuf");

    st.ingestLogs([rec]);
    st.flushPendingRefreshes();
    expect(JSON.stringify(st.viewOf({ span: sp, resource: { attributes: [] } }).input)).toContain("hello from protobuf");
    const row = st.db.prepare("SELECT input_preview FROM spans WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as { input_preview: string | null };
    expect(row.input_preview).toContain("hello from protobuf");
  });
});
