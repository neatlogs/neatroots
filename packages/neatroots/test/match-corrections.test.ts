import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateRule } from "../src/checks/rules.js";
import type { RuleCheck } from "../src/checks/types.js";
import { loadTrace } from "../src/engine/trace.js";
import { Store } from "../src/store/db.js";
import { batch, hex, s, span, tmpHome } from "./helpers.js";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = tmpHome();
  homes.push(home);
  const store = new Store(path.join(home, "data"));
  stores.push(store);
  return { store, traceId: hex(16) };
}

function check(field: "input" | "output" | "error" | "name", pattern = "^blocked$"): RuleCheck {
  return { id: "corrected-match", kind: "rule", rule: { type: "match", field, pattern, flags: "" } };
}

describe("custom match rules after a span correction", () => {
  for (const field of ["input", "output", "error", "name"] as const) {
    it.each([false, true])(`re-evaluates ${field} when its same-length match becomes %s`, (matched) => {
      const { store, traceId } = fixture();
      const original = span({ traceId, name: "lookup", kind: "tool" });
      const version = (value: string) => ({
        ...original,
        name: field === "name" ? value : original.name,
        status: field === "error" ? { code: 2, message: value } : original.status,
        attributes: [...original.attributes!, ...(field === "input" || field === "output" ? [s(`neatlogs.tool.${field}`, value)] : [])],
      });
      const rule = check(field);
      store.ingest([batch([version(matched ? "allowed" : "blocked")])]);
      const before = loadTrace(store, traceId);
      expect(!!evaluateRule(rule, before, false, undefined, true)).toBe(!matched);
      store.ingest([batch([version(matched ? "blocked" : "allowed")])]);
      const after = loadTrace(store, traceId);
      expect(after.spans[0].seq).toBeGreaterThan(before.spans[0].seq);
      expect(!!evaluateRule(rule, after, false, undefined, true)).toBe(matched);
    });
  }

  it("keeps text-item boundaries in the memo identity", () => {
    const { store, traceId } = fixture();
    store.ingest([batch([span({ traceId, name: "lookup", kind: "tool" })])]);
    const snapshot = loadTrace(store, traceId);
    const output = (texts: string[]) => ({ content: texts.map((text) => ({ type: "text", text })) });
    const before = output(["a", "bc"]);
    const after = output(["ab", "c"]);
    expect(JSON.stringify(before).length).toBe(JSON.stringify(after).length);
    const withOutput = (value: typeof before) => ({ ...snapshot, spans: [{ ...snapshot.spans[0], output: value }] });
    const rule = check("output", "^ab$");
    expect(evaluateRule(rule, withOutput(before), false, undefined, true)).toBeNull();
    expect(evaluateRule(rule, withOutput(after), false, undefined, true)?.firing).toBe(true);
  });
});
