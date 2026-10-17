import { describe, expect, it } from "vitest";
import { parseTraceFile } from "../src/ingest/importers/file.js";

describe.each(["traces.jsonl", "traces.NDJSON", "traces.json"])("line numbers in %s", (name) => {
  it("counts leading blank lines when reporting malformed JSON", () => {
    const text = '\n \t\n{"name":"valid"}\n{invalid}\n';
    expect(() => parseTraceFile(text, name)).toThrow(`${name} line 4:`);
  });

  it("counts blank CRLF lines when reporting an unsupported record", () => {
    const text = '\r\n \t\r\n{"name":"valid"}\r\n\r\n{}\r\n';
    expect(() => parseTraceFile(text, name)).toThrow(`${name} line 5: not OTLP JSON`);
  });

  it("still accepts a BOM, surrounding whitespace, and blank lines", () => {
    const text = '\uFEFF\r\n \t\r\n{"name":"first"}\r\n\r\n{"name":"second"}\r\n \t';
    const batches = parseTraceFile(text, name);
    expect(batches.map((batch) => batch.spans[0].name)).toEqual(["first", "second"]);
  });
});
