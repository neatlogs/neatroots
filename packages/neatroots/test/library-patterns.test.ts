import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { testWithin } from "../src/util/regex.js";
import type { RuleCheck } from "../src/checks/types.js";

const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];

/**
 * The time limit in `checks/rules.ts` only guards patterns from checks people write. A library
 * pattern runs with no watchdog, so a slow one stalls the whole server on a single span, and the
 * store, the app and every steering hook wait with it.
 *
 * `soft-tool-failure` had exactly that: `(^|\n)\s*error:` cost a quadratic scan per newline, so
 * 200 KB of newlines held the only thread for over 30 seconds. These inputs are the shapes that
 * make a pattern backtrack; the budget is far above what a linear pattern needs on 200 KB (tens of
 * milliseconds) and far below what a quadratic one takes (seconds).
 */
const BUDGET_MS = 1000;
const SHAPES: [string, string][] = [
  ["newlines", "\n".repeat(200_000)],
  ["newlines and indentation", ("\n" + "  ").repeat(66_000)],
  ["newlines and tabs", ("\n\t").repeat(100_000)],
  ["blank lines with trailing spaces", ("\n   \n").repeat(50_000)],
  ["spaces", " ".repeat(200_000)],
  ["quotes and colons", '":'.repeat(100_000)],
  ["quotes", '"'.repeat(200_000)],
  ["brackets", "[".repeat(200_000)],
  ["braces", "{".repeat(200_000)],
  ["error: repeated", "error:".repeat(30_000)],
  ["indented error: repeated", "\n  error:".repeat(20_000)],
  ["traceback repeated", "Traceback (most recent call last)".repeat(6_000)],
  ["HTTP and digits", "HTTP 500".repeat(25_000)],
  ["status json repeated", '"status":"500"'.repeat(15_000)],
  ["error json repeated", '"error":"x"'.repeat(15_000)],
  ["sk- prefix repeated", "sk-".repeat(60_000)],
  ["BEGIN key repeated", "-----BEGIN ".repeat(18_000)],
  ["Bearer repeated", "Bearer ".repeat(30_000)],
  ["rate limit repeated", "rate limit exceeded".repeat(10_000)],
  ["words and newlines", "order shipped\n".repeat(15_000)],
];

describe("library patterns", () => {
  it("has at least one match rule to guard", () => {
    expect(lib.filter((c) => c.rule.type === "match").length).toBeGreaterThan(0);
  });

  it("stays within the budget on input built to make it backtrack", () => {
    const slow: string[] = [];
    for (const check of lib) {
      if (check.rule.type !== "match") continue;
      const re = new RegExp(check.rule.pattern, check.rule.flags ?? "i");
      for (const [label, text] of SHAPES) {
        if (testWithin(re, text, BUDGET_MS) === undefined) slow.push(`${check.id} on ${label}`);
      }
    }
    expect(slow).toEqual([]);
  });
});
