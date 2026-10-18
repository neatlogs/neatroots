import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, toolSpan, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const rules = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks;
function hit(kind: "llm" | "tool", output: string) {
  const home = tmpHome(); homes.push(home);
  const store = new Store(path.join(home, "data"));
  try {
    const trace = hex(16), root = hex(8);
    const span = kind === "llm" ? llmSpan(trace, root, { user: "Synthetic input", out: output }) : toolSpan(trace, root, "synthetic_config", "{}", output);
    store.ingest([batch([span])]);
    const rule = rules.find((r) => r.id === (kind === "llm" ? "secret-in-output" : "secret-in-tool-output")) as RuleCheck;
    return evaluateRule(rule, loadTrace(store, trace), false);
  } finally { store.close(); }
}
const families = [
  { name: "temporary AWS", key: "ASIA" + "A1".repeat(8), short: "ASIA" + "A".repeat(15), wrongCase: "asia" + "A1".repeat(8) },
  { name: "webhook", key: "whsec_" + "aB1".repeat(8), short: "whsec_" + "a".repeat(23), wrongCase: "WHSEC_" + "aB1".repeat(8) },
  { name: "Neatlogs", key: "nlsa_" + "aB1_-".repeat(3) + "Z", short: "nlsa_" + "a".repeat(15), wrongCase: "NLSA_" + "aB1".repeat(6) },
];
describe.each(["llm", "tool"] as const)("%s output alignment", (kind) => {
  it.each(families)("detects $name in JSON, assignments and punctuation without echoing it", ({ key }) => {
    for (const output of [JSON.stringify({ key }), `KEY=${key}`, `(${key})`]) {
      const result = hit(kind, output);
      expect(result?.firing).toBe(true);
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });
  it.each(families)("rejects $name near misses and embedded identifiers", ({ key, short, wrongCase }) => {
    for (const output of [short, wrongCase, `prefix-${key}`, `prefix_${key}`]) expect(hit(kind, output)).toBeNull();
  });
  it("keeps literal-space, case-sensitive, minimum-24 Bearer behavior", () => {
    expect(hit(kind, `Authorization: Bearer ${"aB1".repeat(8)}`)?.firing).toBe(true);
    for (const prefix of ["bearer ", "BEARER ", "Bearer\t"]) expect(hit(kind, prefix + "aB1".repeat(8))).toBeNull();
    expect(hit(kind, "Bearer " + "a".repeat(23))).toBeNull();
  });
  it("preserves public-key, documentation and context-free exclusions", () => {
    for (const output of ["pk_live_" + "a".repeat(24), "postgres://user:password@localhost:5432/mydb", "mongodb://admin:admin@localhost:27017", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12"]) expect(hit(kind, output)).toBeNull();
  });
});
