import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, makeRoots, tmpHome, toolSpan, trackedStore, type TestRoots } from "./helpers.js";

// A `match` pattern from a check someone (or a coding agent) wrote can backtrack for minutes, e.g.
// overlapping alternatives in a repeat. It must not stall neatroots.

const homes: string[] = [];
let tb: TestRoots | undefined;
afterEach(async () => {
  closeTrackedStores();
  await tb?.close();
  tb = undefined;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const SLOW = "a".repeat(40) + "!";
const check = (id: string, pattern: string): RuleCheck =>
  parseChecks(`id: ${id}\nkind: rule\nrule:\n  type: match\n  field: output\n  pattern: '${pattern}'\n`).checks[0] as RuleCheck;

function trace(output: string) {
  const h = tmpHome();
  homes.push(h);
  const st = trackedStore(path.join(h, "data"));
  const t = hex(16);
  st.ingest([batch([toolSpan(t, hex(8), "lookup", "{}", output)])]);
  return loadTrace(st, t);
}

describe("match patterns from checks people write", () => {
  it("give up on a pattern that runs too long, and skip it from then on", () => {
    const slow = check("slow-pattern", "(a|aa)+$");
    const snap = trace(SLOW);
    let started = Date.now();
    expect(evaluateRule(slow, snap, true, undefined, true)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    started = Date.now();
    expect(evaluateRule(slow, snap, true, undefined, true)).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("still match normally when the pattern is fine", () => {
    const fine = check("refund-mention", "refund (done|failed)");
    const hit = evaluateRule(fine, trace('{"status":"refund done"}'), true, undefined, true);
    expect(hit?.firing).toBe(true);
    expect(evaluateRule(fine, trace('{"status":"no change"}'), true, undefined, true)).toBeNull();
  });

  it("keep the server answering when such a check is saved and a matching span arrives", async () => {
    tb = await makeRoots({ serve: true });
    const saved = await fetch(`${tb.url}/api/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: { id: "slow-user-check", kind: "rule", rule: { type: "match", field: "output", pattern: "(a|aa)+$" } } }),
    });
    expect(saved.status).toBeLessThan(300);
    const t = hex(16);
    const started = Date.now();
    tb.roots.ingest([batch([toolSpan(t, hex(8), "lookup", "{}", SLOW)])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    const status = await fetch(`${tb.url}/api/status`);
    expect(status.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
