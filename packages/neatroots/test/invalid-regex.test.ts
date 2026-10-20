import { describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";

const rule = (pattern: string, flags = "") => `
id: bad-pattern
kind: rule
rule:
  type: match
  field: output
  pattern: '${pattern}'
${flags ? `  flags: ${flags}\n` : ""}`;

describe("match rule pattern", () => {
  it("rejects a pattern that does not compile", () => {
    for (const p of ["(", "[a-", "*abc", "a{2,1}", "(?<n"]) {
      const { checks, errors } = parseChecks(rule(p));
      expect(checks).toHaveLength(0);
      expect(errors[0].message).toMatch(/pattern/);
    }
  });

  it("rejects unknown flags", () => {
    expect(parseChecks(rule("abc", "zz")).errors).toHaveLength(1);
  });

  it("accepts ordinary patterns", () => {
    for (const p of ["abc", "sk-[a-z]{4}", "(a|b)+", "\\\\d{3}"]) {
      expect(parseChecks(rule(p)).errors).toEqual([]);
    }
  });

  it("labeled smoke: 120 patterns, 60 valid and 60 invalid, every verdict matches", () => {
    const good = ["abc", "sk-[a-z]{4}", "(a|b)+", "\\d{3}", "^x$", "a.*b", "[0-9]+", "(?:foo|bar)baz", "\\bword\\b", "x{2,5}"];
    const bad = ["(", ")", "[a-", "*abc", "+x", "a{2,1}", "(?<n", "\\", "[z-a]", "(?P<n>x)"];
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 120; i++) {
      const isBad = i % 2 === 1;
      const src = isBad ? bad[(i >> 1) % bad.length] : good[(i >> 1) % good.length];
      const rejected = parseChecks(rule(src)).errors.length > 0;
      if (isBad && rejected) tp++;
      else if (isBad) fn++;
      else if (rejected) fp++;
      else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
