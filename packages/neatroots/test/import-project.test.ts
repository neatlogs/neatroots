import { describe, expect, it } from "vitest";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import type { ResourceSpansBatch } from "../src/otlp/types.js";
import { hex } from "./helpers.js";

const otlp = (service: string) =>
  JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeSpans: [{ scope: { name: "x" }, spans: [{ traceId: hex(16), spanId: hex(8), name: "root", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", status: {} }] }] }] });
const http = (project: string) => JSON.stringify({ name: "run", project, children: [{ name: "c" }] });
const jsonl = (project: string) => `${http(project)}\n${http(project)}\n`;
const exportFile = () =>
  JSON.stringify({ data: { schemaVersion: 1, trace: { traceId: hex(16), workflowName: "wf" }, spans: [{ traceId: hex(16), spanId: "1234567890abcdef", parentSpanId: null, spanName: "root", spanType: "workflow", startedAt: "2026-10-09T10:00:00Z", endedAt: null, durationMs: 5, status: "OK" }] } });

const project = (b: ResourceSpansBatch) => b.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue;

describe("import project", () => {
  it("an explicit project wins over the one in the file", () => {
    expect(parseTraceFile(otlp("own"), "t.json", "mine").map(project)).toEqual(["mine"]);
    expect(parseTraceFile(http("own"), "t.json", "mine").map(project)).toEqual(["mine"]);
    expect(parseTraceFile(jsonl("own"), "t.jsonl", "mine").map(project)).toEqual(["mine", "mine"]);
    expect(parseTraceFile(exportFile(), "e.json", "mine").map(project)).toEqual(["mine"]);
  });

  it("keeps the project in the file when none is given", () => {
    expect(parseTraceFile(otlp("own"), "t.json").map(project)).toEqual(["own"]);
    expect(parseTraceFile(http("own"), "t.json").map(project)).toEqual(["own"]);
    expect(parseTraceFile(exportFile(), "e.json").map(project)).toEqual(["wf"]);
  });

  it("fails on a file with no traces", () => {
    for (const text of ["[]", "{\"resourceSpans\":[]}"]) expect(() => parseTraceFile(text, "t.json")).toThrow(/no traces/);
  });

  it("labeled smoke: 120 imports, 60 with --project and 60 without, every project is right", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    const makers: [(p: string) => string, string][] = [[otlp, "t.json"], [http, "t.json"], [jsonl, "t.jsonl"]];
    for (let i = 0; i < 120; i++) {
      const explicit = i % 2 === 0;
      const [make, file] = makers[(i >> 1) % 3];
      const got = parseTraceFile(make("own"), file, explicit ? "mine" : undefined).map(project);
      const right = got.every((p) => p === (explicit ? "mine" : "own"));
      if (explicit && right) tp++;
      else if (explicit) fn++;
      else if (!right) fp++;
      else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
