import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, s, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "context-growth") as RuleCheck;

function fires(tokens: number[]): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  const t = hex(16);
  const root = hex(8);
  const spans = tokens.map((n, i) => {
    const sp = llmSpan(t, root, { user: `step ${i}`, out: "ok" });
    const a = sp.attributes ?? [];
    for (let j = 0; j < a.length; j++) {
      const k = (a[j] as { key: string }).key;
      if (k === "neatlogs.llm.token_count.total" || k === "neatlogs.llm.token_count.prompt") a[j] = s(k, n);
    }
    sp.startTimeUnixNano = String(BigInt(1_700_000_000_000 + i * 1000) * 1_000_000n);
    sp.endTimeUnixNano = String(BigInt(1_700_000_000_500 + i * 1000) * 1_000_000n);
    return sp;
  });
  st.ingest([batch(spans)]);
  const hit = evaluateRule(rule, loadTrace(st, t)!, false);
  st.close?.();
  return !!hit;
}

function ramp(n: number, start: number, mul: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(start * Math.pow(mul, i)));
}

describe("context-growth rule", () => {
  it("fires on steady growth (60 labeled runs)", () => {
    let fire = 0;
    for (let i = 0; i < 60; i++) {
      const calls = 5 + (i % 6);
      const start = 300 + (i % 5) * 100;
      const mul = 1.5 + (i % 4) * 0.25;
      const seq = ramp(calls, start, mul);
      if (seq[seq.length - 1] < 4000) seq.push(4000 + i * 50);
      if (fires(seq)) fire++;
    }
    expect(fire).toBe(60);
  });

  it("stays quiet on normal runs (60 labeled clean controls)", () => {
    let fire = 0;
    for (let i = 0; i < 60; i++) {
      const k = i % 6;
      let seq: number[];
      if (k === 0) seq = [1500, 1600, 1500, 1700, 1600, 1500]; // flat
      else if (k === 1) seq = [500, 600, 20000, 700, 650, 600]; // one big call
      else if (k === 2) seq = [800, 900, 1000, 1100, 1200, 1300]; // slow growth, small
      else if (k === 3) seq = [300, 400, 800]; // too few calls
      else if (k === 4) seq = [9000, 8000, 7000, 6000, 5000, 4000]; // shrinking
      else seq = [2000, 2100, 2000, 2200, 2100, 5000]; // one late jump, not steady
      seq = seq.map((n) => n + (i % 7));
      if (fires(seq)) fire++;
    }
    expect(fire).toBe(0);
  });

  it("stays quiet with no llm calls", () => {
    expect(fires([])).toBe(false);
  });
});
