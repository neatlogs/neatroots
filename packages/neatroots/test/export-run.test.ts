import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { checkHint, writeExport } from "../src/cli/data.js";
import { parseTraceFile } from "../src/ingest/importers/index.js";
import { encodeTraceJson } from "../src/otlp/codec.js";
import { batch, hex, llmSpan, makeRoots, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-run-"));
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("GET /api/runs/:traceId/otlp", () => {
  it("saves a run as a file that neatroots check and import read back unchanged", async () => {
    t = await makeRoots({ serve: true, noEngine: true });
    const traceId = hex(16);
    const root = span({ traceId, name: "refund-agent", kind: "workflow" });
    const calls = [1, 2, 3].map(() => toolSpan(traceId, root.spanId, "lookup_order", '{"id":4512}', "", "HTTP 404"));
    const answer = llmSpan(traceId, root.spanId, { user: "Refund order 4512", out: "Done, refunded." });
    t.roots.ingest([batch([root, ...calls, answer], "refund-agent")]);

    const res = await fetch(`${t.url}/api/runs/${traceId}/otlp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`${traceId}.json`);
    const file = path.join(dir, `${traceId}.json`);
    fs.writeFileSync(file, await res.text());

    const back = parseTraceFile(fs.readFileSync(file, "utf8"), file).flatMap((b) => b.spans);
    expect(back.map((x) => x.spanId).sort()).toEqual([root, ...calls, answer].map((x) => x.spanId).sort());
    expect(back.find((x) => x.spanId === answer.spanId)?.attributes).toEqual(expect.arrayContaining(answer.attributes));

    const r = checkFiles([file]);
    expect(r.errors).toEqual([]);
    expect(r.runs[0].trace_id).toBe(traceId);
    expect(r.runs[0].findings.map((f) => f.check_id)).toContain("tool-error-streak");
  });

  it("keeps the resource and scope schema URLs where OTLP puts them", () => {
    const b = batch([span({ traceId: hex(16), name: "a", kind: "workflow" })], "svc");
    b.resource.schemaUrl = "https://opentelemetry.io/schemas/1.26.0";
    b.scope.schemaUrl = "https://opentelemetry.io/schemas/1.27.0";
    const [back] = parseTraceFile(JSON.stringify(encodeTraceJson([b])), "run.json");
    expect(back.resource.schemaUrl).toBe("https://opentelemetry.io/schemas/1.26.0");
    expect(back.scope.schemaUrl).toBe("https://opentelemetry.io/schemas/1.27.0");
  });

  it("answers 404 for a run it doesn't have", async () => {
    t = await makeRoots({ serve: true, noEngine: true });
    expect((await fetch(`${t.url}/api/runs/${hex(16)}/otlp`)).status).toBe(404);
  });
});

describe("neatroots export writes the file atomically", () => {
  it("replaces an existing export and leaves no temp file", () => {
    const out = path.join(dir, "replace.json");
    fs.writeFileSync(out, "old");
    writeExport(out, { resourceSpans: [] });
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ resourceSpans: [] });
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("replace.json."))).toEqual([]);
  });

  it("never writes through a file planted at a predictable temp name", () => {
    const out = path.join(dir, "planted.json");
    // What a fixed `<out>.neatroots-tmp` would have followed (as a symlink) or truncated.
    fs.writeFileSync(`${out}.neatroots-tmp`, "someone else's file");
    writeExport(out, { resourceSpans: [] });
    expect(fs.readFileSync(`${out}.neatroots-tmp`, "utf8")).toBe("someone else's file");
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ resourceSpans: [] });
  });

  it("a write that fails part-way keeps the previous file intact", () => {
    const out = path.join(dir, "keep.json");
    fs.writeFileSync(out, '{"resourceSpans":[]}');
    // JSON.stringify throws on a BigInt: the export fails and the previous file must be untouched.
    expect(() => writeExport(out, { resourceSpans: [{ n: 1n }] })).toThrow();
    expect(fs.readFileSync(out, "utf8")).toBe('{"resourceSpans":[]}');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("keep.json."))).toEqual([]);
  });

  it("quotes the path in the printed check command", () => {
    expect(checkHint("abc123.json")).toBe("neatroots check abc123.json");
    expect(checkHint("my runs/bad run.json")).toBe("neatroots check 'my runs/bad run.json'");
    expect(checkHint("-report.json")).toBe("neatroots check -- -report.json");
  });

  it.skipIf(process.platform === "win32")("keeps an existing export's permissions when replacing it", () => {
    const out = path.join(dir, "private.json");
    fs.writeFileSync(out, "{}", { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    writeExport(out, { resourceSpans: [] });
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });
});
