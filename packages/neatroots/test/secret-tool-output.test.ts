import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = lib.find((c) => c.id === "secret-in-tool-output")!;

function run(toolOut: string, llmOut?: string) {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    const root = hex(8);
    const spans = [toolSpan(t, root, "fetch_config", "{}", toolOut)];
    if (llmOut) spans.push(llmSpan(t, root, { user: "hi", out: llmOut }));
    st.ingest([batch(spans)]);
    return evaluateRule(rule, loadTrace(st, t), false);
  } finally {
    st.close();
  }
}

const random = (n: number, seed: number) => {
  const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let x = seed, o = "";
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; o += a[x % a.length]; }
  return o;
};

describe("secret-in-tool-output", () => {
  it("loads and fires on a key in a tool result", () => {
    expect(rule).toBeDefined();
    expect(run('{"key":"sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"}')?.firing).toBe(true);
  });

  it("never puts the secret in the finding", () => {
    const hit = run('{"key":"sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"}')!;
    expect(JSON.stringify(hit)).not.toContain("4f9a8b7c");
  });

  it("is case sensitive for Bearer, so prose does not match", () => {
    expect(run("the bearer of this message is a person")).toBeNull();
  });

  it("does not look at model output (that is secret-in-output)", () => {
    expect(run("{}", "here is sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });

  it("labeled smoke: 120 generated tool results, no misses and no false alarms", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 120; i++) {
      const kind = i % 6;
      let out: string, expectFire: boolean;
      if (kind === 0) { out = `{"api_key":"sk-${random(32, i)}"}`; expectFire = true; }
      else if (kind === 1) { out = `token=ghp_${random(36, i)}`; expectFire = true; }
      else if (kind === 2) { out = `Authorization: Bearer ${random(40, i)}`; expectFire = true; }
      else if (kind === 3) { out = `{"order":"${1000 + i}","status":"shipped","note":"sk-short"}`; expectFire = false; }
      else if (kind === 4) { out = `The bearer of order ${i} should sign here. Key ${random(12, i)}`; expectFire = false; }
      else { out = `{"rows":[${i},${i + 1}],"cursor":"${random(30, i)}"}`; expectFire = false; }
      const fired = run(out)?.firing === true;
      if (expectFire && fired) tp++; else if (expectFire) fn++; else if (fired) fp++; else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
