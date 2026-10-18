import zlib from "node:zlib";
import type { Context, Hono } from "hono";
import {
  decodeLogsJson,
  decodeLogsProtobuf,
  decodeTraceJson,
  decodeTraceProtobuf,
  encodeTraceResponse,
} from "../otlp/codec.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import { traceReadback } from "./readback.js";
import { HttpTraceError, httpTraceToBatches } from "../ingest/http-trace.js";
import type { Roots } from "../core.js";
import { log } from "../util/log.js";

const MAX_BODY = 64 * 1024 * 1024;

function gunzipCapped(raw: Buffer): Buffer {
  try {
    return zlib.gunzipSync(raw, { maxOutputLength: MAX_BODY * 4 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw Object.assign(new Error("payload too large after decompression"), { status: 413 });
    }
    throw err;
  }
}

async function readBody(c: Context): Promise<Buffer> {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
  const enc = (c.req.header("content-encoding") ?? "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return gunzipCapped(raw);
  if (enc === "deflate") return zlib.inflateSync(raw, { maxOutputLength: MAX_BODY * 4 });
  if (enc === "br") return zlib.brotliDecompressSync(raw, { maxOutputLength: MAX_BODY * 4 });
  // Some exporters gzip without the header; sniff the magic bytes.
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) return gunzipCapped(raw);
  return raw;
}

function isJson(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("json");
}

/**
 * The OTLP/HTTP collector. It accepts exactly what the public Neatlogs SDKs send
 * to ingest.neatlogs.com (protobuf or JSON, gzip, x-api-key), so pointing
 * NEATLOGS_ENDPOINT at neatroots needs no SDK change. The api key is accepted and ignored.
 */
export function mountCollector(app: Hono, roots: Roots): void {
  app.post("/v1/traces", async (c) => {
    let batches: ResourceSpansBatch[];
    const json = isJson(c);
    try {
      const body = await readBody(c);
      batches = json ? decodeTraceJson(JSON.parse(body.toString("utf8"))) : decodeTraceProtobuf(body);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      log.warn(`rejected OTLP trace payload: ${(err as Error).message}`);
      return c.json({ code: 3, message: `invalid OTLP payload: ${(err as Error).message}` }, status as 400);
    }
    try {
      roots.ingest(batches);
    } catch (err) {
      log.error("ingest failed", err);
      return c.json({ code: 13, message: "neatroots could not store this batch" }, 500);
    }
    if (json) return c.json({ partialSuccess: {} });
    return new Response(Buffer.from(encodeTraceResponse()), {
      status: 200,
      headers: { "content-type": "application/x-protobuf" },
    });
  });

  // The Neatlogs HTTP trace API and Browser SDK: one JSON tree per request, no ids.
  app.post("/v1/trace", async (c) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(c)).toString("utf8"));
    } catch (err) {
      return c.json({ error: "Validation error", details: { body: `not JSON: ${(err as Error).message}` } }, 400);
    }
    try {
      const { batches, traceId, spans } = httpTraceToBatches(parsed);
      roots.ingest(batches);
      return c.json({ success: true, trace_id: traceId, spans });
    } catch (err) {
      if (err instanceof HttpTraceError) return c.json({ error: err.message, details: err.details }, 400);
      log.error("HTTP trace ingest failed", err);
      return c.json({ error: "neatroots could not store this trace" }, 500);
    }
  });

  app.post("/v1/logs", async (c) => {
    try {
      const body = await readBody(c);
      const records = isJson(c) ? decodeLogsJson(JSON.parse(body.toString("utf8"))) : decodeLogsProtobuf(body);
      roots.store.ingestLogs(records);
    } catch (err) {
      return c.json({ code: 3, message: `invalid OTLP logs payload: ${(err as Error).message}` }, 400);
    }
    if (isJson(c)) return c.json({ partialSuccess: {} });
    return new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/x-protobuf" } });
  });

  // Metrics are accepted so exporters do not retry, but neatroots does not use them.
  app.post("/v1/metrics", async (c) => {
    await c.req.arrayBuffer();
    if (isJson(c)) return c.json({ partialSuccess: {} });
    return new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/x-protobuf" } });
  });

  // The SDKs' optional large-payload upload flow (uploads_enabled, default off) needs an
  // HTTPS object store. neatroots runs on plain localhost, so it answers with a clear,
  // non-retryable reason and the SDK keeps its documented truncation behavior.
  app.post("/v1/telemetry/uploads", (c) =>
    c.json(
      {
        state: "rejected",
        diagnostic: { stage: "prepare", reason_code: "uploads_unavailable_local", retryable: false },
      },
      501,
    ),
  );

  app.get("/api/traces/v3/:traceId", (c) => {
    const r = traceReadback(roots.store, c.req.param("traceId").toLowerCase());
    return c.json(r.body, r.status as 200);
  });
}
