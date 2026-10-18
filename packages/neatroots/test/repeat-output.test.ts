import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function run(calls: Array<{ input: string; output?: string; error?: string }>) {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    const root = hex(8);
    st.ingest([batch(calls.map((c) => toolSpan(t, root, "search", c.input, c.output, c.error)))]);
    return evaluateRule(rule, loadTrace(st, t), false);
  } finally {
    st.close();
  }
}
const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = lib.find((c) => c.id === "repeated-tool-call")!;

describe("repeated-tool-call compares the result", () => {
  it("fires when the same call returns the same result three times", () => {
    const c = { input: '{"q":"x"}', output: '{"rows":[]}' };
    expect(run([c, c, c])?.firing).toBe(true);
  });

  it("does not fire when the result changes between calls (polling, pagination)", () => {
    expect(run([1, 2, 3].map((n) => ({ input: '{"q":"x"}', output: `{"page":${n}}` })))).toBeNull();
  });

  it("still fires on identical errors", () => {
    const c = { input: '{"q":"x"}', error: "404" };
    expect(run([c, c, c])?.firing).toBe(true);
  });

  it("labeled smoke: 120 generated runs, no misses and no false alarms", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 120; i++) {
      const kind = i % 4;
      const n = 3 + (i % 3);
      const input = `{"q":"item-${i}"}`;
      let calls: Array<{ input: string; output?: string; error?: string }>;
      let expectFire: boolean;
      if (kind === 0) { calls = Array.from({ length: n }, () => ({ input, output: `{"hits":${i}}` })); expectFire = true; }
      else if (kind === 1) { calls = Array.from({ length: n }, (_, k) => ({ input, output: `{"hits":${i},"page":${k}}` })); expectFire = false; }
      else if (kind === 2) { calls = Array.from({ length: n }, () => ({ input, error: `HTTP 5${i % 10}0` })); expectFire = true; }
      else { calls = Array.from({ length: n }, (_, k) => ({ input: `{"q":"item-${i}-${k}"}`, output: `{"hits":${i}}` })); expectFire = false; }
      const fired = run(calls)?.firing === true;
      if (expectFire && fired) tp++; else if (expectFire) fn++; else if (fired) fp++; else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
