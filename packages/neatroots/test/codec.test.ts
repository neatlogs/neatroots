import { describe, expect, it } from "vitest";
import { decodeTraceJson, decodeTraceProtobuf, encodeTraceRequest } from "../src/otlp/codec.js";
import type { ResourceSpansBatch } from "../src/otlp/types.js";
import { batch, hex, s, span } from "./helpers.js";

describe("OTLP codec", () => {
  it("round-trips every value type through protobuf without loss", () => {
    const traceId = hex(16);
    const sp = span({
      traceId,
      name: "root",
      kind: "workflow",
      attrs: [
        s("str", "hello"),
        s("int", 42),
        { key: "bigint", value: { intValue: "9007199254740993" } },
        s("dbl", 1.5),
        s("bool", false),
        { key: "bytes", value: { bytesValue: Buffer.from([1, 2, 3]).toString("base64") } },
        { key: "arr", value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: "2" }] } } },
        { key: "kv", value: { kvlistValue: { values: [{ key: "inner", value: { boolValue: true } }] } } },
      ],
      events: [{ timeUnixNano: "1700000000000000000", name: "exception", attributes: [s("exception.message", "boom")] }],
    });
    sp.traceState = "k=v";
    const input: ResourceSpansBatch[] = [batch([sp])];
    input[0].scope.version = "1.2.3";
    const decoded = decodeTraceProtobuf(encodeTraceRequest(input));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].resource.attributes).toEqual(input[0].resource.attributes);
    expect(decoded[0].scope.name).toBe("neatlogs.test");
    expect(decoded[0].scope.version).toBe("1.2.3");
    const out = decoded[0].spans[0];
    expect(out.traceId).toBe(traceId);
    expect(out.spanId).toBe(sp.spanId);
    expect(out.attributes).toEqual(sp.attributes);
    expect(out.events).toEqual(sp.events);
    expect(out.startTimeUnixNano).toBe(sp.startTimeUnixNano);
    expect(out.traceState).toBe("k=v");
    expect(out.status).toEqual({ code: 1 });
  });

  it("decodes OTLP/JSON with hex ids, string enums and snake_case", () => {
    const traceId = hex(16);
    const spanId = hex(8);
    const body = {
      resource_spans: [
        {
          resource: { attributes: [{ key: "service.name", value: { string_value: "svc" } }] },
          scope_spans: [
            {
              scope: { name: "x" },
              spans: [
                {
                  trace_id: traceId,
                  span_id: spanId,
                  parent_span_id: "",
                  name: "n",
                  kind: "SPAN_KIND_CLIENT",
                  start_time_unix_nano: 1700000000000000000,
                  end_time_unix_nano: "1700000000100000000",
                  attributes: [{ key: "n", value: { int_value: 7 } }],
                  status: { code: "STATUS_CODE_ERROR", message: "bad" },
                },
              ],
            },
          ],
        },
      ],
    };
    const [b] = decodeTraceJson(body);
    expect(b.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "svc" } });
    expect(b.spans[0]).toMatchObject({ traceId, spanId, parentSpanId: "", kind: 3, status: { code: 2, message: "bad" } });
    expect(b.spans[0].attributes[0].value).toEqual({ intValue: "7" });
    expect(b.spans[0].endTimeUnixNano).toBe("1700000000100000000");
  });

  it("accepts base64 ids from non-conforming JSON exporters and drops spans with zero ids", () => {
    const tid = Buffer.from(hex(16), "hex");
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "x" },
              spans: [
                { traceId: tid.toString("base64"), spanId: Buffer.from(hex(8), "hex").toString("base64"), name: "ok" },
                { traceId: "00000000000000000000000000000000", spanId: "0000000000000000", name: "zero" },
              ],
            },
          ],
        },
      ],
    };
    const [b] = decodeTraceJson(body);
    expect(b.spans).toHaveLength(1);
    expect(b.spans[0].traceId).toBe(tid.toString("hex"));
  });

  it("rejects a non-array resourceSpans instead of silently dropping it", () => {
    // A string (or any non-array) would otherwise iterate as characters and
    // produce an empty, 200-with-nothing-stored result.
    expect(() => decodeTraceJson({ resourceSpans: "oops" } as any)).toThrow(/resourceSpans must be an array/);
    expect(() => decodeTraceJson({ resourceSpans: 123 } as any)).toThrow(/resourceSpans must be an array/);
    // a valid (possibly empty) array is still fine
    expect(decodeTraceJson({ resourceSpans: [] } as any)).toEqual([]);
  });

  it("normalizes non-string status.message to string without dropping or throwing", () => {
    const traceId = hex(16);
    const spanId = hex(8);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "x" },
              spans: [
                {
                  traceId,
                  spanId,
                  name: "obj-msg",
                  status: { code: 2, message: { text: "boom" } },
                },
                {
                  traceId,
                  spanId: hex(8),
                  name: "num-msg",
                  status: { code: 2, message: 500 },
                },
              ],
            },
          ],
        },
      ],
    };
    const [b] = decodeTraceJson(body);
    expect(b.spans[0].status.message).toBe('{"text":"boom"}');
    expect(b.spans[1].status.message).toBe("500");
  });
});
