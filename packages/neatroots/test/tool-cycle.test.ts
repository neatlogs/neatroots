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
const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "tool-cycle") as RuleCheck;

type Call = [name: string, input: string, output: string];

function fires(calls: Call[]): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    const root = hex(8);
    const spans = calls.map(([n, i, o], k) => {
      const sp = toolSpan(t, root, n, i, o);
      sp.startTimeUnixNano = String(BigInt(1_700_000_000_000 + k * 1000) * 1_000_000n);
      sp.endTimeUnixNano = String(BigInt(1_700_000_000_500 + k * 1000) * 1_000_000n);
      return sp;
    });
    st.ingest([batch(spans)]);
    const hit = evaluateRule(rule, loadTrace(st, t)!, false);
    return !!hit?.firing;
  } finally {
    st.close();
  }
}

const TOOLS = ["search", "fetch", "read_file", "edit_file", "run_tests", "list_dir"];

describe("tool-cycle rule", () => {
  it("fires when tools go around with new inputs and the same results (60 labeled runs)", () => {
    let fire = 0;
    for (let i = 0; i < 60; i++) {
      const period = 2 + (i % 2);
      const pat = TOOLS.slice(i % 3, (i % 3) + period);
      const cycles = 4 + (i % 4);
      const calls: Call[] = [];
      if (i % 3 === 0) calls.push(["list_dir", `{"p":"/"}`, `{"files":${i}}`]); // some progress first
      for (let c = 0; c < cycles; c++) for (const n of pat) calls.push([n, `{"q":"try ${c}-${i}"}`, `{"result":"nothing for ${n}"}`]);
      if (fires(calls)) fire++;
    }
    expect(fire).toBe(60);
  });

  it("stays quiet on real work and near misses (60 labeled clean controls)", () => {
    let fire = 0;
    for (let i = 0; i < 60; i++) {
      const k = i % 6;
      const calls: Call[] = [];
      if (k === 0) for (let c = 0; c < 6; c++) calls.push(["search", `{"q":"item ${c}"}`, `{"hits":["doc${c}-${i}"]}`], ["fetch", `{"url":"u${c}"}`, `{"body":"page ${c}-${i}"}`]); // alternates, results differ
      else if (k === 1) for (let c = 0; c < 3; c++) calls.push(["search", `{"q":"${c}"}`, `{"r":"same"}`], ["fetch", `{"u":"${c}"}`, `{"r":"same2"}`]); // only 3 cycles
      else if (k === 2) for (let c = 0; c < 8; c++) calls.push(["run_tests", `{"n":${c}}`, `{"r":"same"}`]); // one tool, repeat rule's job
      else if (k === 3) for (let c = 0; c < 10; c++) calls.push([TOOLS[(c * 7 + i) % 6], `{"c":${c}}`, `{"r":"x${c}"}`]); // varied
      else if (k === 4) {
        for (let c = 0; c < 5; c++) calls.push(["edit_file", `{"c":${c}}`, `{"r":"ok"}`], ["run_tests", `{"c":${c}}`, `{"r":"same"}`]);
        calls.push(["read_file", `{"p":"new"}`, `{"r":"fresh"}`]); // cycle ended with a new call
      } else for (let c = 0; c < 4; c++) calls.push(["edit_file", `{"c":${c}}`, `{"r":"ok${c}"}`], ["run_tests", `{"c":${c}}`, `{"r":"fail ${c - 1 < 0 ? 9 : 4 - c}"}`]); // failures shrinking
      if (fires(calls)) fire++;
    }
    expect(fire).toBe(0);
  });

  it("stays quiet with no tool calls", () => {
    expect(fires([])).toBe(false);
  });
});
