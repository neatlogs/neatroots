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
  "sk_" + "live_abcdefghijklmnopqrstuvwx",
  "rk_" + "live_abcdefghijklmnopqrstuvwx",
  "git" + "hub_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz",
  "gho" + "_abcdefghijklmnopqrstuvwxyz0123456789",
  "AIz" + "aSyA1234567890abcdefghijklmnopqrstuv",
  "SG." + "abcdefghijklmnop.qrstuvwxyz012345",
  "npm" + "_abcdefghijklmnopqrstuvwxyz0123456789",
  "SK0" + "123456789abcdef0123456789abcdef",
  "hf_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  "dck" + "r_pat_abcdefghijklmnopqrstuvwx",
  "dop" + "_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "gsk" + "_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  "ya2" + "9.abcdefghijklmnopqrstuvwxyz0123",
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
  "use sk_live_ keys only on the server",
  "git" + "hub_pat_ tokens are fine-grained",
  "connect to postgres://localhost:5432/main",
  "see https://example.com:8080/path",
  "email me at user@example.com",
  "the JWT header starts with eyJ",
  "SKU12345 is out of stock",
  "set aws_secret_access_key in your config",
  "npm" + "_config is an env prefix",
  // Publishable keys are public by design.
  "pk_" + "live_abcdefghijklmnopqrstuvwx",
  // Credentials inside a connection string are the app's own config, not a leaked key.
  "pos" + "tgres://app:s3cretpw@db.internal:5432/main",
  "pos" + "tgres://user:password@localhost:5432/mydb",
  "mon" + "godb://admin:admin@localhost:27017",
  // Docs examples and placeholders are not live keys.
  "aws" + "_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
  "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk",
  "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  // SK followed by 32 hex chars inside a longer identifier is not a key.
  "TAS" + "K0123456789abcdef0123456789abcdef",
  // A key glued to a preceding underscore has no word boundary, same as the redactor.
  "token_ghp_abcdefghijklmnopqrstuvwxyz0123456789",
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
