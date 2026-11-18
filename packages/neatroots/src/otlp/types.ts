/**
 * OTLP shapes as neatroots keeps them. Values stay in OTLP's typed AnyValue form so
 * a stored span can be re-exported to Neatlogs Cloud without loss (int64 stays a
 * string, int vs double and bytes are preserved).
 */

export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } }
  | Record<string, never>;

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface OtlpResource {
  attributes: KeyValue[];
  droppedAttributesCount?: number;
  schemaUrl?: string;
}

export interface OtlpScope {
  name: string;
  version?: string;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
  schemaUrl?: string;
}

export interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: KeyValue[];
  droppedAttributesCount?: number;
}

export interface OtlpLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attributes: KeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
}

/** One span, ids as lowercase hex, times as decimal nanosecond strings. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  traceState?: string;
  flags?: number;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  droppedAttributesCount?: number;
  events: OtlpEvent[];
  droppedEventsCount?: number;
  links: OtlpLink[];
  droppedLinksCount?: number;
  status: { code: number; message?: string };
}

export interface ResourceSpansBatch {
  resource: OtlpResource;
  scope: OtlpScope;
  spans: OtlpSpan[];
}

export type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };

export function anyToPlain(v: AnyValue | undefined): Plain {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : v.intValue;
  }
  if ("doubleValue" in v) return v.doubleValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyToPlain);
  if ("kvlistValue" in v) return kvToPlain(v.kvlistValue?.values ?? []);
  return null;
}

export function kvToPlain(kvs: KeyValue[] | undefined): Record<string, Plain> {
  const out: Record<string, Plain> = {};
  for (const kv of kvs ?? []) setOwn(out, kv.key, anyToPlain(kv.value));
  return out;
}

/**
 * Sets a key that came from a trace as a plain own property. `obj[key] = value` with a key such
 * as `__proto__` would replace the object's prototype instead (or, through a chain, the global
 * one); defining it keeps the key and its value exactly as sent.
 */
export function setOwn(obj: Record<string, Plain>, key: string, value: Plain): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

export function plainToAny(v: unknown): AnyValue {
  if (v === null || v === undefined) return {};
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(plainToAny) } };
  if (typeof v === "object") {
    return {
      kvlistValue: {
        values: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: plainToAny(value) })),
      },
    };
  }
  return { stringValue: String(v) };
}

export function attr(kvs: KeyValue[] | undefined, key: string): Plain | undefined {
  const kv = kvs?.find((k) => k.key === key);
  return kv ? anyToPlain(kv.value) : undefined;
}

export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

/** OTLP span flags: bit 8 says the parent's location was known at send time, bit 9 says it is remote. */
export const FLAGS_CONTEXT_HAS_IS_REMOTE = 0x100;
export const FLAGS_CONTEXT_IS_REMOTE = 0x200;

/** A span whose parent lives in another process (the agent was called with a propagated traceparent). */
export function hasRemoteParent(span: { flags?: number }): boolean {
  const flags = span.flags ?? 0;
  return (flags & FLAGS_CONTEXT_HAS_IS_REMOTE) !== 0 && (flags & FLAGS_CONTEXT_IS_REMOTE) !== 0;
}
