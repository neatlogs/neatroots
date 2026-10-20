import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, llmSpan, tmpHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const lib = parseChecks(fs.readFileSync(path.join(__dirname, "../library/rules.yaml"), "utf8"));
const check = lib.checks.find((c) => c.id === "secret-in-output") as RuleCheck;

function fires(output: string): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    st.ingest([batch([llmSpan(t, hex(8), { user: "hi", out: output })])]);
    return evaluateRule(check, loadTrace(st, t), false) !== null;
  } finally {
    st.close();
  }
}

const KEYS = [
  "sk-proj-abcdefghijklmnopqrstuvwx",
  "AKIAIOSFODNN7EXAMPLE",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "xoxb-1234567890-abcdefgh",
  "-----BEGIN RSA PRIVATE KEY-----",
];
const NEAR = [
  "akiaiosfodnn7example",
  "use the ghp_ prefix for tokens",
  "SK-PROJ-ABCDEFGHIJKLMNOPQRSTUVWX is not a key format",
  "ghp_short",
  "xox is a prefix",
  "the sk- prefix marks a key",
  "-----begin rsa private key-----",
  "Akiaiosfodnn7example",
];

describe("secret-in-output", () => {
  it("matches real key shapes", () => {
    for (const k of KEYS) expect(fires(`here you go: ${k}`)).toBe(true);
  });

  it("does not match lowercase or short look-alikes", () => {
    for (const n of NEAR) expect(fires(n)).toBe(false);
  });

  it("labeled smoke: 120 outputs, 60 with a key and 60 look-alikes, every verdict matches", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 120; i++) {
      const isKey = i % 2 === 0;
      const body = isKey ? KEYS[(i >> 1) % KEYS.length] : NEAR[(i >> 1) % NEAR.length];
      const text = ["", "result: ", "the value is ", "```\n"][i % 4] + body;
      const hit = fires(text);
      if (isKey && hit) tp++;
      else if (isKey) fn++;
      else if (hit) fp++;
      else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
