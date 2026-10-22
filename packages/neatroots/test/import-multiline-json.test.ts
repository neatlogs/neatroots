import { describe, expect, it } from "vitest";
import { parseTraceFile } from "../src/ingest/importers/file.js";

describe("multiline JSON file", () => {
  it("accepts a valid document with objects starting at column zero", () => {
    const data = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "root", startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [] }] }] }] };
    const text = JSON.stringify(data, null, 2).replace(/^ +/gm, "");
    expect(parseTraceFile(text, "trace.json")).toHaveLength(1);
  });
});

describe("JSON and line formats", () => {
  const a = { name: "first" }, b = { name: "second" };
  it("keeps explicit JSONL and NDJSON support and original error names", () => {
    for (const name of ["trace.jsonl", "trace.NDJSON", "trace.json"])
      expect(parseTraceFile(`${JSON.stringify(a)}\n${JSON.stringify(b)}`, name)).toHaveLength(2);
    expect(() => parseTraceFile('{"name":"ok"}\n{bad}', "trace.json")).toThrow(/trace.json line 2/);
  });
  it("rejects invalid whole-document content without treating it as line data", () => {
    expect(() => parseTraceFile('null', "trace.json")).toThrow(/expected a JSON object/);
    expect(() => parseTraceFile('{}', "trace.json")).toThrow(/not OTLP JSON/);
  });
  it("labeled smoke: 60 multiline documents and 60 line-format controls", () => {
    for (let i = 0; i < 120; i++) {
      const multiline = i % 2 === 0;
      const text = multiline ? `{\n"name":"root",\n"children":[\n${JSON.stringify(a)}\n]\n}` : `${JSON.stringify(a)}\n${JSON.stringify(b)}`;
      expect(parseTraceFile(text, "trace.json")).toHaveLength(multiline ? 1 : 2);
    }
  });
});

describe("OTLP JSON import marker", () => {
  it("marks a collector dump as imported", () => {
    const data = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "root", startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [] }] }] }] };
    const [b] = parseTraceFile(JSON.stringify(data), "dump.json");
    expect(b.resource.attributes.find((a) => a.key === "neatroots.import.source")?.value).toEqual({ stringValue: "file" });
  });
});
