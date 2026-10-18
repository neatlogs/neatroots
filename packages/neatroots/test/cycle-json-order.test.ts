import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, hex, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "tool-cycle") as RuleCheck;

function fires(outputs: (i: number) => string): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = trackedStore(path.join(h, "data"));
  const t = hex(16);
  const root = hex(8);
  const spans = [];
  for (let i = 0; i < 4; i++) {
    spans.push(toolSpan(t, root, "search", `{"q":"flights ${i}"}`, outputs(i)));
    spans.push(toolSpan(t, root, "refine", `{"q":"flights ${i}"}`, '{"q":"flights"}'));
  }
  spans.forEach((sp, k) => {
    sp.startTimeUnixNano = String(BigInt(1_700_000_000_000 + k * 1000) * 1_000_000n);
    sp.endTimeUnixNano = String(BigInt(1_700_000_000_500 + k * 1000) * 1_000_000n);
  });
  st.ingest([batch(spans)]);
  return !!evaluateRule(rule, loadTrace(st, t)!, false);
}

describe("tool-cycle and JSON key order", () => {
  it("treats the same result with its keys reordered as the same result", () => {
    expect(fires(() => '{"results":[],"total":0}')).toBe(true);
    expect(fires((i) => (i % 2 ? '{"total":0,"results":[]}' : '{"results":[],"total":0}'))).toBe(true);
  });

  it("still treats a changed value or array order as a new result", () => {
    expect(fires((i) => `{"results":[],"total":${i}}`)).toBe(false);
    expect(fires((i) => (i % 2 ? '{"results":[1,2]}' : '{"results":[2,1]}'))).toBe(false);
  });
});
