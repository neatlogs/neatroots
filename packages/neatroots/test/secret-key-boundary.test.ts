import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";

// The secret rules match key prefixes like sk- anywhere in a word, so a slug such as
// task-add-user-authentication-flow read as an "sk-…" key. Prefixes now have to start a token.
const lib = parseChecks(fs.readFileSync(path.join(__dirname, "../library/rules.yaml"), "utf8"));

function matcher(id: string): RegExp {
  const c = lib.checks.find((x) => x.id === id) as RuleCheck;
  const r = c.rule as { pattern: string; flags?: string };
  return new RegExp(r.pattern, r.flags ?? "i");
}

const WORDS = [
  "I created branch task-add-user-authentication-flow and pushed it",
  "Saved the file as risk-assessment-report-q3-2026.md",
  "Set the kiosk-mode-configuration-for-lobby flag",
  "Added the class desk-top-navigation-container",
  "see ticket ASK-1234-follow-up-on-billing-migration",
  "the variable MAKIAIOSFODNN7EXAMPLE is just a name",
  "hello world, the ask-me-anything-session-notes doc",
];

const KEYS = [
  "sk-proj-abcdefghijklmnopqrstuvwx",
  "sk-ant-api03-abcdefghijklmnopqrstuvwx",
  "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx",
  'api_key: "sk-abcdefghijklmnopqrstuvwx"',
  "{\"key\":\"sk-abcdefghijklmnopqrstuvwx\"}",
  "line one\nsk-abcdefghijklmnopqrstuvwx",
  "(AKIAIOSFODNN7EXAMPLE)",
  "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "SLACK=xoxb-1234567890-abcdefgh",
  "-----BEGIN RSA PRIVATE KEY-----",
  "x-----BEGIN OPENSSH PRIVATE KEY-----",
];

describe.each(["secret-in-output", "secret-in-tool-output"])("%s key boundary", (id) => {
  const re = matcher(id);
  it("ignores words that only contain a key prefix", () => {
    for (const w of WORDS) expect(re.test(w), w).toBe(false);
  });
  it("still matches keys after punctuation, quotes, = and newlines", () => {
    for (const k of KEYS) expect(re.test(k), k).toBe(true);
  });
});

it("secret-in-tool-output still matches bearer tokens", () => {
  expect(matcher("secret-in-tool-output").test("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
});
