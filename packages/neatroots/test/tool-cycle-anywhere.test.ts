import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { checkFiles } from "../src/checks/offline.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "tool-cycle") as RuleCheck;

/** Five rounds of search -> fetch with nothing new, then the agent asks the user. */
function brokenCycle(t: string) {
  const root = hex(8);
  const calls: [string, string, string][] = [];
  for (let c = 0; c < 5; c++) calls.push(["search", `{"q":"c"}`, `{"hits":[]}`], ["fetch", `{"u":"c"}`, `{"body":""}`]);
  calls.push(["ask_user", `{"q":"which one?"}`, `{"a":"the second"}`]);
  return calls.map(([n, i, o], k) => {
    const sp = toolSpan(t, root, n, i, o);
    sp.startTimeUnixNano = String(BigInt(1_700_000_000_000 + k * 1000) * 1_000_000n);
    sp.endTimeUnixNano = String(BigInt(1_700_000_000_500 + k * 1000) * 1_000_000n);
    return sp;
  });
}

describe("tool-cycle the agent broke out of", () => {
  it("is reported by neatroots check", () => {
    const h = tmpHome();
    homes.push(h);
    const file = path.join(h, "trace.json");
    const b = batch(brokenCycle(hex(16)));
    fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: b.resource, scopeSpans: [{ scope: b.scope, spans: b.spans }] }] }));
    const { runs } = checkFiles([file], { only: ["tool-cycle"] });
    expect(runs.flatMap((r) => r.findings.map((f) => f.check_id))).toEqual(["tool-cycle"]);
  });

  it("fires live when the cycle and the next step arrive in one batch, and only then", () => {
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    const spans = brokenCycle(t);
    st.ingest([batch(spans)]);
    const snap = loadTrace(st, t)!;
    const all = evaluateRule(rule, snap, false, new Set(snap.spans.map((s) => s.id)));
    expect(all?.firing).toBe(true);
    expect(all?.params).toMatchObject({ pattern: "search -> fetch", count: "5" });
    expect(all?.evidenceSpanIds).toHaveLength(10);
    // Only ask_user is new: the cycle already ended before this batch, so it no longer holds.
    const askUser = snap.spans.find((s) => s.toolName === "ask_user")!;
    const later = evaluateRule(rule, snap, false, new Set([askUser.id]));
    expect(later).not.toBeNull();
    expect(later?.firing).toBe(false);
    st.close();
  });
});
