import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { httpTraceToBatches } from "../src/ingest/http-trace.js";
import { checkFromInput } from "../src/server/api.js";
import type { RuleCheck } from "../src/checks/types.js";
import { makeRoots } from "./helpers.js";

const YAML = `id: refund-needs-lookup
kind: rule
title: Refund without looking up the order
rule:
  type: requires_before
  span: { tool: issue_refund }
  requires: { tool: lookup_order }
`;

const call = (tool: string) => ({ name: tool, tool_name: tool, input: "{}", output: '{"ok":true}', duration_ms: 10 });
const run = (...tools: string[]) => ({ name: "agent", project: "refunds", children: tools.map(call), output: "done" });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requires-before-satisfied-"));
const cleanup: (() => Promise<void>)[] = [];
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

// evaluateRule answers { firing: false } for a requires_before whose calls all have a prerequisite,
// so a live finding raised before a late span arrived can resolve. Whole-run callers must not
// read that as a violation.
describe("requires_before that is satisfied", () => {
  it("neatroots check passes a run that looked the order up first", () => {
    const checks = path.join(dir, "checks");
    fs.mkdirSync(checks);
    fs.writeFileSync(path.join(checks, "refund.yaml"), YAML);
    const file = (name: string, tools: string[]) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(run(...tools)));
      return p;
    };
    const r = checkFiles([file("good.json", ["lookup_order", "issue_refund"]), file("bad.json", ["issue_refund"])], { dirs: [checks], only: ["refund-needs-lookup"] });
    expect(r.errors).toEqual([]);
    expect(r.runs.map((x) => x.findings.map((f) => f.check_id))).toEqual([[], ["refund-needs-lookup"]]);
  });

  it("preview does not count a run that looked the order up first", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    tb.roots.ingest(httpTraceToBatches(run("lookup_order", "issue_refund")).batches);
    tb.roots.ingest(httpTraceToBatches(run("issue_refund")).batches);
    const check = checkFromInput(YAML).check as RuleCheck;
    const r = await tb.roots.engine!.previewCheck(check, { limit: 50 });
    expect(r.checked).toBe(2);
    expect(r.hits).toHaveLength(1);
  });
});
