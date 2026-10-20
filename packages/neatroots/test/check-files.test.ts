import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { hex } from "./helpers.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-files-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const kv = (key: string, v: string | number) => ({ key, value: { stringValue: String(v) } });

type Step = { kind: "tool" | "llm"; name: string; ok?: boolean; input?: string; out?: string };
const tool = (name: string, ok = true, input = '{"q":1}'): Step => ({ kind: "tool", name, ok, input, out: "ok" });
const llm = (out = "fine"): Step => ({ kind: "llm", name: "chat", out });

function trace(steps: Step[], traceId = hex(16)): string {
  const t = traceId;
  const root = hex(8);
  const n = 1_700_000_000_000_000_000;
  const spans = steps.map((s, i) => {
    const attrs =
      s.kind === "tool"
        ? [kv("neatlogs.span.kind", "tool"), kv("neatlogs.tool.name", s.name), kv("neatlogs.tool.input", s.input ?? "{}"), ...(s.ok ? [kv("neatlogs.tool.output", s.out ?? "")] : [])]
        : [kv("neatlogs.span.kind", "llm"), kv("neatlogs.llm.output_messages.0.role", "assistant"), kv("neatlogs.llm.output_messages.0.content", s.out ?? ""), kv("neatlogs.llm.token_count.prompt", 100), kv("neatlogs.llm.token_count.completion", 20)];
    const start = n + i * 300_000_000;
    return { traceId: t, spanId: hex(8), parentSpanId: root, name: s.name, kind: 1, startTimeUnixNano: String(start), endTimeUnixNano: String(start + 200_000_000), attributes: attrs, status: s.ok === false ? { code: 2, message: "HTTP 500" } : {} };
  });
  spans.push({ traceId: t, spanId: root, parentSpanId: "" as string, name: "agent", kind: 1, startTimeUnixNano: String(n - 100_000_000), endTimeUnixNano: String(n + 5_000_000_000), attributes: [kv("neatlogs.span.kind", "workflow"), kv("neatlogs.workflow.output", "Done.")], status: {} });
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "check-demo")] }, scopeSpans: [{ scope: { name: "t" }, spans }] }] });
}

const same = (name: string, n: number) => Array.from({ length: n }, () => tool(name, true, '{"q":"x"}'));
const BAD: Step[][] = [
  same("search", 3),
  [tool("a", false), tool("b", false), tool("c", false)],
  [llm("key sk-proj-abcdefghijklmnopqrstuvwx")],
  Array.from({ length: 25 }, () => llm()),
];
const GOOD: Step[][] = [
  [tool("s", true, '{"q":"1"}'), tool("s", true, '{"q":"2"}'), tool("s", true, '{"q":"3"}')],
  [tool("a", false), tool("a"), tool("b", false), tool("b")],
  [llm("all fine")],
  Array.from({ length: 5 }, () => llm()),
];

let seq = 0;
const write = (steps: Step[], traceId?: string) => {
  const p = path.join(dir, `t${seq++}.json`);
  fs.writeFileSync(p, trace(steps, traceId));
  return p;
};

describe("checkFiles", () => {
  it("flags a loop or error streak the agent later moved on from", () => {
    const loop = write([...same("search", 4), tool("summarize", true, '{"n":4}')]);
    const errs = write([
      tool("charge", false, '{"a":1}'), tool("refund", false, '{"a":2}'), tool("lookup", false, '{"a":3}'),
      tool("charge", true, '{"a":4}'), tool("refund", true, '{"a":5}'), tool("lookup", true, '{"a":6}'),
    ]);
    const r = checkFiles([loop, errs]);
    expect(r.runs[0].findings.map((f) => f.check_id)).toContain("repeated-tool-call");
    expect(r.runs[1].findings.map((f) => f.check_id)).toContain("tool-error-streak");
  });

  it("flags a bad run and passes a good one", () => {
    const r = checkFiles([write(BAD[0]), write(GOOD[0])]);
    expect(r.runs.map((x) => x.findings.length > 0)).toEqual([true, false]);
    expect(r.runs[0].findings[0].check_id).toBe("repeated-tool-call");
  });

  it("keeps each file verdict isolated when two files repeat a trace id", () => {
    const checks = path.join(dir, "same-id-checks");
    fs.mkdirSync(checks, { recursive: true });
    fs.writeFileSync(path.join(checks, "bad-span.yaml"), "id: bad-span\nkind: rule\nrule: {type: match, field: name, pattern: '^bad$'}\n");
    const traceId = "0123456789abcdef0123456789abcdef";
    const bad = write([tool("bad")], traceId);
    const clean = write([tool("clean")], traceId);
    const options = { dirs: [checks], only: ["bad-span"] };

    const badFirst = checkFiles([bad, clean], options);
    expect(badFirst.runs.map((run) => run.findings.map((finding) => finding.check_id))).toEqual([["bad-span"], []]);

    const cleanFirst = checkFiles([clean, bad], options);
    expect(cleanFirst.runs.map((run) => run.findings.map((finding) => finding.check_id))).toEqual([[], ["bad-span"]]);
  });

  it("limits to the rules asked for", () => {
    const r = checkFiles([write(BAD[1])], { only: ["secret-in-output"] });
    expect(r.rules).toEqual(["secret-in-output"]);
    expect(r.runs[0].findings).toEqual([]);
  });

  it("rejects an unknown rule id", () => {
    expect(() => checkFiles([write(GOOD[0])], { only: ["nope"] })).toThrow(/no rule check named nope/);
  });

  it("rejects an empty rule list instead of checking nothing", () => {
    expect(() => checkFiles([write(BAD[0])], { only: [] })).toThrow(/names no rule ids/);
  });
  
  it("fails on a file that is not a trace", () => {
    const p = path.join(dir, "junk.json");
    fs.writeFileSync(p, "{oops");
    expect(() => checkFiles([p])).toThrow();
  });

  it("labeled smoke: 120 saved runs, 60 bad and 60 good, every verdict matches", () => {
    const files: [string, boolean][] = [];
    for (let i = 0; i < 120; i++) {
      const bad = i % 2 === 0;
      files.push([write((bad ? BAD : GOOD)[(i >> 1) % 4]), bad]);
    }
    const r = checkFiles(files.map((f) => f[0]));
    let tp = 0, fn = 0, fp = 0, tn = 0;
    r.runs.forEach((run, i) => {
      const fired = run.findings.length > 0;
      if (files[i][1] && fired) tp++;
      else if (files[i][1]) fn++;
      else if (fired) fp++;
      else tn++;
    });
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });

  it("gives each file its own verdict when two files share a trace id, in either order", () => {
    const checks = path.join(dir, "same-trace-checks");
    fs.mkdirSync(checks, { recursive: true });
    fs.writeFileSync(path.join(checks, "bad-name.yaml"), "id: bad-name\nkind: rule\nrule: {type: match, field: name, pattern: '^bad$'}\n");
    const one = (file: string, spanId: string, name: string) => {
      const span = { traceId: "0123456789abcdef0123456789abcdef", spanId, name, kind: 1, startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000010000000", attributes: [], status: { code: 1 } };
      const p = path.join(dir, file);
      fs.writeFileSync(p, JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "t" }, spans: [span] }] }] }));
      return p;
    };
    const bad = one("same-bad.json", "0123456789abcdef", "bad");
    const clean = one("same-clean.json", "fedcba9876543210", "clean");
    const verdicts = (files: string[]) =>
      checkFiles(files, { dirs: [checks], only: ["bad-name"] }).runs.map((r) => [path.basename(r.file), r.findings.flatMap((f) => f.evidence_span_ids)]);
    expect(verdicts([clean])).toEqual([["same-clean.json", []]]);
    expect(verdicts([bad, clean])).toEqual([["same-bad.json", ["0123456789abcdef"]], ["same-clean.json", []]]);
    expect(verdicts([clean, bad])).toEqual([["same-clean.json", []], ["same-bad.json", ["0123456789abcdef"]]]);
  });
});
