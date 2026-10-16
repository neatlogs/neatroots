import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { parseTraceFile } from "../src/ingest/importers/index.js";
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

  it("answers 404 for a run it doesn't have", async () => {
    t = await makeRoots({ serve: true, noEngine: true });
    expect((await fetch(`${t.url}/api/runs/${hex(16)}/otlp`)).status).toBe(404);
  });
});
