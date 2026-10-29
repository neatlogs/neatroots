import * as grpc from "@grpc/grpc-js";
import { decodeLogsProtobuf, decodeTraceProtobuf, encodeTraceResponse } from "../otlp/codec.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import type { Roots } from "../core.js";
import { log } from "../util/log.js";

// OTLP over gRPC on :4317, for OpenTelemetry exporters configured the way Neatlogs documents
// (OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc). Messages are decoded with the same codec as
// OTLP/HTTP, so both paths store identical spans. Like the HTTP collector, any api key is accepted.

const raw = (b: Buffer) => b;
const empty = () => Buffer.from(encodeTraceResponse());

function unary(path: string, handle: (body: Buffer) => void): grpc.ServiceDefinition {
  return {
    Export: {
      path,
      requestStream: false,
      responseStream: false,
      requestSerialize: raw,
      requestDeserialize: raw,
      responseSerialize: raw,
      responseDeserialize: raw,
      originalName: "export",
    } as grpc.MethodDefinition<Buffer, Buffer>,
  } as unknown as grpc.ServiceDefinition;
}

export function startGrpc(roots: Roots): Promise<grpc.Server | null> {
  const port = roots.config.grpcPort;
  if (!port) return Promise.resolve(null);
  const server = new grpc.Server({ "grpc.max_receive_message_length": 64 * 1024 * 1024 });
  const handler =
    (fn: (body: Buffer) => void): grpc.handleUnaryCall<Buffer, Buffer> =>
    (call, callback) => {
      try {
        fn(call.request);
        callback(null, empty());
      } catch (err) {
        log.warn(`rejected OTLP/gRPC payload: ${(err as Error).message}`);
        callback({ code: grpc.status.INVALID_ARGUMENT, details: (err as Error).message });
      }
    };
  server.addService(
    unary("/opentelemetry.proto.collector.trace.v1.TraceService/Export", () => {}),
    { Export: handler((b) => roots.ingest(decodeTraceProtobuf(b) as ResourceSpansBatch[])) },
  );
  server.addService(
    unary("/opentelemetry.proto.collector.logs.v1.LogsService/Export", () => {}),
    { Export: handler((b) => roots.ingestLogs(decodeLogsProtobuf(b))) },
  );
  server.addService(unary("/opentelemetry.proto.collector.metrics.v1.MetricsService/Export", () => {}), { Export: handler(() => {}) });
  return new Promise((resolve) => {
    server.bindAsync(`${roots.config.host}:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        log.warn(`OTLP/gRPC not started on port ${port}: ${err.message}. OTLP/HTTP on port ${roots.config.port} still works.`);
        resolve(null);
        return;
      }
      log.info(`OTLP/gRPC on ${roots.config.host}:${port}`);
      resolve(server);
    });
  });
}
