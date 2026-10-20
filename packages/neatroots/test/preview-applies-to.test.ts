import { afterEach, describe, expect, it } from "vitest";
import { makeRoots } from "./helpers.js";
import { httpTraceToBatches } from "../src/ingest/http-trace.js";
import { checkFromInput } from "../src/server/api.js";
import type { RuleCheck } from "../src/checks/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const YAML = `id: refund-tool-error
kind: rule
title: Refund agent tool failed
applies_to:
  workflow: refund-agent
rule:
  type: errors
  consecutive: 1
  span:
    type: tool
`;

function failedRun(workflow: string) {
  return httpTraceToBatches({ name: workflow, project: workflow, children: [{ name: "call", tool_name: "api_call", input: "x", error: "HTTP 500", duration_ms: 10 }], output: "done" }).batches;
}

// The engine never runs a check on a run outside its applies_to, so preview (the check editor's
// "how often would this fire", and MCP preview_check) must not count those runs either.
describe("previewCheck and applies_to", () => {
  it("only checks runs the check applies to", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    tb.roots.ingest(failedRun("refund-agent"));
    for (let i = 0; i < 3; i++) tb.roots.ingest(failedRun("search-agent"));
    const check = checkFromInput(YAML).check as RuleCheck;
    const all = await tb.roots.engine!.previewCheck(check, { limit: 50 });
    expect(all.checked).toBe(1);
    expect(all.hits.map((h) => h.root_name)).toEqual(["refund-agent"]);
    // The limit counts runs the check applies to, so newer runs of other agents don't crowd it out.
    const one = await tb.roots.engine!.previewCheck(check, { limit: 1 });
    expect(one.checked).toBe(1);
    expect(one.hits).toHaveLength(1);
  });

  it("checks every run when the check has no applies_to", async () => {
    const tb = await makeRoots();
    cleanup.push(() => tb.close());
    tb.roots.ingest(failedRun("refund-agent"));
    tb.roots.ingest(failedRun("search-agent"));
    const check = checkFromInput(YAML.replace(/applies_to:\n  workflow: refund-agent\n/, "")).check as RuleCheck;
    const r = await tb.roots.engine!.previewCheck(check, { limit: 50 });
    expect(r.checked).toBe(2);
    expect(r.hits).toHaveLength(2);
  });
});
