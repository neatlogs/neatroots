import { describe, expect, it } from "vitest";
import { decodeTraceProtobuf } from "../src/otlp/codec.js";
import type { AnyValue, KeyValue } from "../src/otlp/types.js";
import { compileRules, redactBatches } from "../src/relay/redact.js";
import { batch, hex, makeRoots, span } from "./helpers.js";

const KEY = "sk-proj-" + "a".repeat(40);
const CUSTOM = "private-customer-4521";
const MASK = "[redacted:api_key]";

function fixture() {
  const entry = (): KeyValue => ({ key: KEY, value: { stringValue: KEY } });
  const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "root", kind: "workflow" })]);
  b.resource.attributes.push(entry());
  b.resource.schemaUrl = `https://schema.example/${KEY}`;
  b.scope = { name: "library", version: KEY, schemaUrl: CUSTOM, attributes: [entry()] };
  b.spans[0].traceState = `vendor=${KEY}`;
  b.spans[0].attributes.push(entry(), {
    key: "nested",
    value: { arrayValue: { values: [{ kvlistValue: { values: [entry(), entry(), { key: CUSTOM, value: { boolValue: true } }] } }] } },
  });
  b.spans[0].events = [{ name: "event", timeUnixNano: "123", attributes: [entry()] }];
  b.spans[0].links = [{ traceId: hex(16), spanId: hex(8), traceState: `vendor=${KEY}`, attributes: [entry()] }];
  return b;
}

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

describe("redaction of retained OTLP metadata", () => {
  it("redacts keys recursively, metadata and preview locations without mutating source or collapsing duplicate keys", () => {
    const input = [fixture()];
    const snapshot = structuredClone(input);
    freeze(input);
    const { batches, hits } = redactBatches(input, compileRules([CUSTOM]));
    const out = batches[0];
    expect(input).toEqual(snapshot);
    expect(JSON.stringify(batches)).not.toContain(KEY);
    expect(JSON.stringify(batches)).not.toContain(CUSTOM);
    expect(JSON.stringify(hits.map((hit) => hit.where))).not.toContain(KEY);
    expect(JSON.stringify(hits.map((hit) => hit.where))).not.toContain(CUSTOM);
    expect(out.resource.attributes.at(-1)).toEqual({ key: MASK, value: { stringValue: MASK } });
    expect(out.scope.version).toBe(MASK);
    expect(out.scope.schemaUrl).toBe("[redacted:custom]");
    expect(out.resource.schemaUrl).toBe(`https://schema.example/${MASK}`);
    expect(out.spans[0].traceState).toBe(`vendor=${MASK}`);
    expect(out.spans[0].links[0].traceState).toBe(`vendor=${MASK}`);
    const nested = out.spans[0].attributes.find((a) => a.key === "nested")!.value as { arrayValue: { values: { kvlistValue: { values: KeyValue[] } }[] } };
    expect(nested.arrayValue.values[0].kvlistValue.values).toEqual([
      { key: MASK, value: { stringValue: MASK } },
      { key: MASK, value: { stringValue: MASK } },
      { key: "[redacted:custom]", value: { boolValue: true } },
    ]);
    expect(out.spans[0].spanId).toBe(snapshot[0].spans[0].spanId);
    expect(out.spans[0].startTimeUnixNano).toBe(snapshot[0].spans[0].startTimeUnixNano);
    expect(out.spans[0].links[0].traceId).toBe(snapshot[0].spans[0].links[0].traceId);
  });

  it("preserves harmless metadata, typed values, collection order and empty optional strings", () => {
    const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "root", kind: "workflow" })]);
    b.resource.schemaUrl = "https://schema.example/v1";
    b.scope = { name: "lib", version: "1.2.3", schemaUrl: "", attributes: [] };
    b.spans[0].traceState = "vendor=harmless";
    b.spans[0].links = [{ traceId: hex(16), spanId: hex(8), traceState: "", attributes: [] }];
    const values: AnyValue[] = [{ intValue: "9223372036854775807" }, { doubleValue: 1.25 }, { boolValue: false }, { bytesValue: "/wA=" }, {}];
    b.spans[0].attributes = values.map((value) => ({ key: "duplicate", value }));
    const { batches, hits } = redactBatches([b], compileRules([]));
    expect(batches).toEqual([b]);
    expect(hits).toEqual([]);
  });

  it("fails closed when metadata encounters a timed-out custom rule or an invalid rule", () => {
    expect(() => compileRules(["["])).toThrow();
    const b = fixture();
    b.scope.version = "a".repeat(60) + "!";
    expect(() => redactBatches([b], compileRules(["(a+)+$"]))).toThrow(/nothing was sent/);
  });

  it("removes secrets from decoded outgoing OTLP while keeping the stored trace lossless", async () => {
    const t = await makeRoots({ noEngine: true });
    try {
      const b = fixture();
      const traceId = b.spans[0].traceId;
      t.roots.config.cloud.redactPatterns = [CUSTOM];
      t.roots.ingest([b]);
      const stored = structuredClone(t.roots.store.batchesForTraces([traceId]));
      const encoded = t.roots.relay.encode([traceId]);
      const decoded = decodeTraceProtobuf(encoded.main);
      expect(JSON.stringify(decoded)).not.toContain(KEY);
      expect(JSON.stringify(decoded)).not.toContain(CUSTOM);
      expect(decoded[0].resource.attributes.some((a) => a.key === MASK)).toBe(true);
      expect(decoded[0].scope.version).toBe(MASK);
      expect(decoded[0].scope.schemaUrl).toBe("[redacted:custom]");
      expect(decoded[0].spans[0].traceState).toBe(`vendor=${MASK}`);
      expect(decoded[0].spans[0].links[0].traceState).toBe(`vendor=${MASK}`);
      expect(t.roots.store.batchesForTraces([traceId])).toEqual(stored);
      expect(JSON.stringify(stored)).toContain(KEY);
      const preview = await t.roots.relay.preview([traceId]);
      expect(JSON.stringify(preview.redactions.flatMap((r) => r.samples.map((s) => s.where)))).not.toContain(KEY);
    } finally {
      await t.close();
    }
  });
});
