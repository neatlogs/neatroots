import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import type {
  AnyValue,
  KeyValue,
  OtlpEvent,
  OtlpLink,
  OtlpResource,
  OtlpScope,
  OtlpSpan,
  ResourceSpansBatch,
} from "./types.js";

/** Finds the vendored opentelemetry-proto directory from src/ (tsx) or dist/ (built). */
function findProtoDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "proto");
    if (fs.existsSync(path.join(candidate, "opentelemetry"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("neatroots could not find its OTLP proto files");
}

let root: protobuf.Root | undefined;

function protoRoot(): protobuf.Root {
  if (root) return root;
  const dir = findProtoDir();
  const r = new protobuf.Root();
  r.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(dir, target));
  r.loadSync(
    [
      "opentelemetry/proto/collector/trace/v1/trace_service.proto",
      "opentelemetry/proto/collector/logs/v1/logs_service.proto",
    ],
    { keepCase: false },
  );
  r.resolveAll();
  root = r;
  return r;
}

function type(name: string): protobuf.Type {
  return protoRoot().lookupType(name);
}

const TRACE_REQ = "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest";
const TRACE_RESP = "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse";
const LOGS_REQ = "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest";

// ---------------------------------------------------------------- id helpers

const HEX_RE = /^[0-9a-fA-F]*$/;

function bytesToHex(b: Uint8Array | string | undefined | null, expectedLen: number): string {
  if (b === undefined || b === null) return "";
  if (typeof b === "string") {
    if (b.length === 0) return "";
    if (b.length === expectedLen * 2 && HEX_RE.test(b)) return b.toLowerCase();
    const buf = Buffer.from(b, "base64");
    return buf.length ? buf.toString("hex") : "";
  }
  return b.length ? Buffer.from(b).toString("hex") : "";
}

function isZeroId(hex: string): boolean {
  return hex.length === 0 || /^0+$/.test(hex);
}

function longToString(v: unknown): string {
  if (v === undefined || v === null || v === "") return "0";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Math.trunc(v).toString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && v && "low" in v && "high" in v) {
    const { low, high, unsigned } = v as { low: number; high: number; unsigned?: boolean };
    const big = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    return unsigned ? big.toString() : BigInt.asIntN(64, big).toString();
  }
  return String(v);
}

// ---------------------------------------------------------- value normalizer

/** Accepts protobufjs toObject output or OTLP/JSON (camelCase or snake_case). */
function normValue(v: any): AnyValue {
  if (!v || typeof v !== "object") return {};
  const pick = (a: string, b: string) => (a in v ? v[a] : v[b]);
  if ("stringValue" in v || "string_value" in v) return { stringValue: String(pick("stringValue", "string_value") ?? "") };
  if ("boolValue" in v || "bool_value" in v) return { boolValue: Boolean(pick("boolValue", "bool_value")) };
  if ("intValue" in v || "int_value" in v) return { intValue: longToString(pick("intValue", "int_value")) };
  if ("doubleValue" in v || "double_value" in v) return { doubleValue: Number(pick("doubleValue", "double_value")) };
  if ("bytesValue" in v || "bytes_value" in v) {
    const b = pick("bytesValue", "bytes_value");
    return { bytesValue: typeof b === "string" ? b : Buffer.from(b ?? []).toString("base64") };
  }
  if ("arrayValue" in v || "array_value" in v) {
    const arr = pick("arrayValue", "array_value") ?? {};
    return { arrayValue: { values: (arr.values ?? []).map(normValue) } };
  }
  if ("kvlistValue" in v || "kvlist_value" in v) {
    const kv = pick("kvlistValue", "kvlist_value") ?? {};
    return { kvlistValue: { values: normKvs(kv.values) } };
  }
  return {};
}

function normKvs(kvs: any): KeyValue[] {
  if (!Array.isArray(kvs)) return [];
  return kvs.filter((k) => k && typeof k.key === "string").map((k) => ({ key: k.key, value: normValue(k.value) }));
}

function num(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function g(o: any, camel: string, snake: string): any {
  if (!o) return undefined;
  return o[camel] !== undefined ? o[camel] : o[snake];
}

function normResource(r: any): OtlpResource {
  return {
    attributes: normKvs(g(r, "attributes", "attributes")),
    droppedAttributesCount: num(g(r, "droppedAttributesCount", "dropped_attributes_count")) || undefined,
  };
}

function normScope(s: any, schemaUrl?: string): OtlpScope {
  return {
    name: s?.name ?? "",
    version: s?.version || undefined,
    attributes: normKvs(s?.attributes),
    droppedAttributesCount: num(g(s, "droppedAttributesCount", "dropped_attributes_count")) || undefined,
    schemaUrl: schemaUrl || undefined,
  };
}

function normStatusCode(c: any): number {
  if (typeof c === "number") return c;
  if (c === "STATUS_CODE_OK") return 1;
  if (c === "STATUS_CODE_ERROR") return 2;
  return Number(c) || 0;
}

function normKind(k: any): number {
  if (typeof k === "number") return k;
  const names = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
  const i = names.indexOf(String(k));
  return i >= 0 ? i : Number(k) || 0;
}

function normSpan(s: any): OtlpSpan | null {
  const traceId = bytesToHex(g(s, "traceId", "trace_id"), 16);
  const spanId = bytesToHex(g(s, "spanId", "span_id"), 8);
  if (isZeroId(traceId) || isZeroId(spanId)) return null;
  const parent = bytesToHex(g(s, "parentSpanId", "parent_span_id"), 8);
  const status = s.status ?? {};
  return {
    traceId,
    spanId,
    parentSpanId: isZeroId(parent) ? "" : parent,
    traceState: g(s, "traceState", "trace_state") || undefined,
    flags: num(s.flags) || undefined,
    name: String(s.name ?? ""),
    kind: normKind(s.kind),
    startTimeUnixNano: longToString(g(s, "startTimeUnixNano", "start_time_unix_nano")),
    endTimeUnixNano: longToString(g(s, "endTimeUnixNano", "end_time_unix_nano")),
    attributes: normKvs(s.attributes),
    droppedAttributesCount: num(g(s, "droppedAttributesCount", "dropped_attributes_count")) || undefined,
    events: (s.events ?? []).map(
      (e: any): OtlpEvent => ({
        timeUnixNano: longToString(g(e, "timeUnixNano", "time_unix_nano")),
        name: String(e.name ?? ""),
        attributes: normKvs(e.attributes),
        droppedAttributesCount: num(g(e, "droppedAttributesCount", "dropped_attributes_count")) || undefined,
      }),
    ),
    droppedEventsCount: num(g(s, "droppedEventsCount", "dropped_events_count")) || undefined,
    links: (s.links ?? []).map(
      (l: any): OtlpLink => ({
        traceId: bytesToHex(g(l, "traceId", "trace_id"), 16),
        spanId: bytesToHex(g(l, "spanId", "span_id"), 8),
        traceState: g(l, "traceState", "trace_state") || undefined,
        attributes: normKvs(l.attributes),
        droppedAttributesCount: num(g(l, "droppedAttributesCount", "dropped_attributes_count")) || undefined,
        flags: num(l.flags) || undefined,
      }),
    ),
    droppedLinksCount: num(g(s, "droppedLinksCount", "dropped_links_count")) || undefined,
    status: { code: normStatusCode(status.code), message: normStatusMessage(status.message) },
  };
}

function normStatusMessage(msg: unknown): string | undefined {
  if (msg === undefined || msg === null) return undefined;
  if (typeof msg === "string") return msg || undefined;
  if (typeof msg === "object") {
    try {
      return JSON.stringify(msg);
    } catch {
      return String(msg);
    }
  }
  return String(msg);
}

/**
 * A repeated field as a list of objects. Anything else (a string iterates as characters) would
 * silently drop the data with a 200, so it is rejected and the collector answers 400, like the
 * protobuf path does for malformed input. A missing field is an empty list.
 */
function objects(v: unknown, name: string): any[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  v.forEach((x, i) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${name}[${i}] must be an object`);
  });
  return v;
}

function normRequest(obj: any): ResourceSpansBatch[] {
  const out: ResourceSpansBatch[] = [];
  for (const rs of objects(g(obj, "resourceSpans", "resource_spans"), "resourceSpans")) {
    const resource = normResource(rs.resource);
    resource.schemaUrl = g(rs, "schemaUrl", "schema_url") || undefined;
    for (const ss of objects(g(rs, "scopeSpans", "scope_spans") ?? g(rs, "instrumentationLibrarySpans", "instrumentation_library_spans"), "scopeSpans")) {
      const scope = normScope(ss.scope ?? g(ss, "instrumentationLibrary", "instrumentation_library"), g(ss, "schemaUrl", "schema_url"));
      const spans = objects(ss.spans, "spans").map(normSpan).filter((x: OtlpSpan | null): x is OtlpSpan => x !== null);
      if (spans.length) out.push({ resource, scope, spans });
    }
  }
  return out;
}

// --------------------------------------------------------------- public API

export function decodeTraceProtobuf(buf: Uint8Array): ResourceSpansBatch[] {
  const T = type(TRACE_REQ);
  const msg = T.decode(buf);
  const obj = T.toObject(msg, { longs: String, bytes: String, enums: Number, defaults: false, arrays: true });
  return normRequest(obj);
}

export function decodeTraceJson(body: unknown): ResourceSpansBatch[] {
  return normRequest(body);
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityText?: string;
  severityNumber?: number;
  body: AnyValue;
  attributes: KeyValue[];
  traceId: string;
  spanId: string;
  resource: OtlpResource;
  scope: OtlpScope;
}

function normLogs(obj: any): OtlpLogRecord[] {
  const out: OtlpLogRecord[] = [];
  for (const rl of objects(g(obj, "resourceLogs", "resource_logs"), "resourceLogs")) {
    const resource = normResource(rl.resource);
    for (const sl of objects(g(rl, "scopeLogs", "scope_logs"), "scopeLogs")) {
      const scope = normScope(sl.scope);
      for (const lr of objects(g(sl, "logRecords", "log_records"), "logRecords")) {
        out.push({
          timeUnixNano: longToString(g(lr, "timeUnixNano", "time_unix_nano") ?? g(lr, "observedTimeUnixNano", "observed_time_unix_nano")),
          severityText: g(lr, "severityText", "severity_text") || undefined,
          severityNumber: num(g(lr, "severityNumber", "severity_number")),
          body: normValue(lr.body),
          attributes: normKvs(lr.attributes),
          traceId: bytesToHex(g(lr, "traceId", "trace_id"), 16),
          spanId: bytesToHex(g(lr, "spanId", "span_id"), 8),
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

export function decodeLogsProtobuf(buf: Uint8Array): OtlpLogRecord[] {
  const T = type(LOGS_REQ);
  const obj = T.toObject(T.decode(buf), { longs: String, bytes: String, enums: Number, defaults: false, arrays: true });
  return normLogs(obj);
}

export function decodeLogsJson(body: unknown): OtlpLogRecord[] {
  return normLogs(body);
}

/** An empty ExportTraceServiceResponse (full success). */
export function encodeTraceResponse(): Uint8Array {
  const T = type(TRACE_RESP);
  return T.encode(T.create({})).finish();
}

// ----------------------------------------------------------------- encoding

function hexToBytes(hex: string): Uint8Array {
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : new Uint8Array();
}

function valueForEncode(v: AnyValue): any {
  if ("bytesValue" in v) return { bytesValue: Uint8Array.from(Buffer.from(v.bytesValue, "base64")) };
  if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map(valueForEncode) } };
  if ("kvlistValue" in v) return { kvlistValue: { values: kvsForEncode(v.kvlistValue.values) } };
  return v;
}

function kvsForEncode(kvs: KeyValue[] | undefined): any[] {
  return (kvs ?? []).map((kv) => ({ key: kv.key, value: valueForEncode(kv.value) }));
}

function spanForEncode(s: OtlpSpan): any {
  return {
    traceId: hexToBytes(s.traceId),
    spanId: hexToBytes(s.spanId),
    parentSpanId: s.parentSpanId ? hexToBytes(s.parentSpanId) : undefined,
    traceState: s.traceState,
    flags: s.flags,
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
    attributes: kvsForEncode(s.attributes),
    droppedAttributesCount: s.droppedAttributesCount,
    events: s.events.map((e) => ({
      timeUnixNano: e.timeUnixNano,
      name: e.name,
      attributes: kvsForEncode(e.attributes),
      droppedAttributesCount: e.droppedAttributesCount,
    })),
    droppedEventsCount: s.droppedEventsCount,
    links: s.links.map((l) => ({
      traceId: hexToBytes(l.traceId),
      spanId: hexToBytes(l.spanId),
      traceState: l.traceState,
      attributes: kvsForEncode(l.attributes),
      droppedAttributesCount: l.droppedAttributesCount,
      flags: l.flags,
    })),
    droppedLinksCount: s.droppedLinksCount,
    status: { code: s.status.code, message: s.status.message },
  };
}

/** Builds an OTLP/protobuf ExportTraceServiceRequest from stored batches. */
export function encodeTraceRequest(batches: ResourceSpansBatch[]): Uint8Array {
  const T = type(TRACE_REQ);
  const obj = {
    resourceSpans: batches.map((b) => ({
      resource: {
        attributes: kvsForEncode(b.resource.attributes),
        droppedAttributesCount: b.resource.droppedAttributesCount,
      },
      schemaUrl: b.resource.schemaUrl,
      scopeSpans: [
        {
          scope: {
            name: b.scope.name,
            version: b.scope.version,
            attributes: kvsForEncode(b.scope.attributes),
            droppedAttributesCount: b.scope.droppedAttributesCount,
          },
          schemaUrl: b.scope.schemaUrl,
          spans: b.spans.map(spanForEncode),
        },
      ],
    })),
  };
  // fromObject converts decimal-string int64 values (times, intValue) without precision loss;
  // verify() would reject them, so it is not used here.
  return T.encode(T.fromObject(obj)).finish();
}
