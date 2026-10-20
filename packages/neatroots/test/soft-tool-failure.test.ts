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
const rule = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "soft-tool-failure") as RuleCheck;

const FAILS = [
  '{"error":"rate limit exceeded, retry in 30s"}',
  '{"error": {"code": 429, "message": "slow down"}}',
  '{"errors":["invalid token"]}',
  '{"status":"error","error":"upstream timeout"}',
  '{"exception":"KeyError: user_id"}',
  '{"status":500,"detail":"boom"}',
  '{"status_code":"429","detail":"quota"}',
  '{"http_status":503}',
  "HTTP 503 Service Unavailable",
  "HTTP 404 not found",
  "Error: connection refused",
  "Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>\nValueError: bad",
  "429 Too Many Requests",
  "Internal Server Error",
  "Rate limit exceeded",
  "service unavailable, try later",
  '{"data":null,"error":"not found"}',
  '{"result":[],"errors":[{"msg":"bad"}]}',
  '{"ok":false,"error":"forbidden"}',
  '{"status":"429"}',
];
const CLEAN = [
  '{"results":[{"id":1,"name":"shoe"}]}',
  '{"error":null}',
  '{"error":""}',
  '{"errors":[]}',
  '{"error":false}',
  '{"error_count":0}',
  '{"status":"ok"}',
  '{"status":200}',
  '{"status_code":201}',
  "no errors found",
  "0 errors, 0 warnings",
  "our api has a rate limit of 100 requests per minute",
  "order shipped",
  '{"status":"success","items":3}',
  "Error handling guide for developers",
  '{"error_rate":0.02}',
  '{"message":"saved","id":"p-500"}',
  '{"total":500,"count":404}',
  "The weather in Paris is 18 C",
  '{"answer":"42"}',
];

function fires(output: string): boolean {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  try {
    const t = hex(16);
    st.ingest([batch([toolSpan(t, hex(8), "lookup", '{"q":"x"}', output)])]);
    return evaluateRule(rule, loadTrace(st, t), false)?.firing === true;
  } finally {
    st.close();
  }
}

describe("soft-tool-failure", () => {
  it("fires on failure-looking output from a call that did not fail (60 cases)", () => {
    let hit = 0;
    for (let i = 0; i < 60; i++) {
      const base = FAILS[i % FAILS.length];
      const out = i < 20 ? base : i < 40 ? `${base}\nattempt ${i}` : `result ${i}\n${base}`;
      if (fires(out)) hit++;
    }
    expect(hit).toBe(60);
  });

  it("stays quiet on normal output, including words like error and rate limit (60 controls)", () => {
    let hit = 0;
    for (let i = 0; i < 60; i++) {
      const base = CLEAN[i % CLEAN.length];
      const out = i < 20 ? base : i < 40 ? `${base} ` : `${base}\nrow ${i}`;
      if (fires(out)) hit++;
    }
    expect(hit).toBe(0);
  });

  it("ignores spans that failed, which tool-error-streak already covers", () => {
    const h = tmpHome();
    homes.push(h);
    const st = trackedStore(path.join(h, "data"));
    const t = hex(16);
    st.ingest([batch([toolSpan(t, hex(8), "lookup", "{}", '{"error":"boom"}', "boom")])]);
    expect(evaluateRule(rule, loadTrace(st, t), false)).toBeNull();
  });

  it("fires on failure-looking output when span status is unset (code 0)", () => {
    const h = tmpHome();
    homes.push(h);
    const st = trackedStore(path.join(h, "data"));
    const t = hex(16);
    const sp = toolSpan(t, hex(8), "lookup", "{}", '{"error":"rate limit exceeded"}');
    sp.status = { code: 0 };
    st.ingest([batch([sp])]);
    const hit = evaluateRule(rule, loadTrace(st, t), false);
    expect(hit?.firing).toBe(true);

    // Clean output with status code 0 stays quiet
    const tClean = hex(16);
    const spClean = toolSpan(tClean, hex(8), "lookup", "{}", '{"status":"ok","items":5}');
    spClean.status = { code: 0 };
    st.ingest([batch([spClean])]);
    expect(evaluateRule(rule, loadTrace(st, tClean), false)).toBeNull();
  });

  it("fires on an error: line at the start of the output or of any line", () => {
    // The alternative is `(^|\n)[^\S\n]*error:` rather than `(^|\n)\s*error:`, because `\s*` after
    // `\n` is quadratic on a run of newlines. `[^\S\n]` is the same indentation without letting the
    // scan cross a line break, so every form below must still fire.
    expect(fires("error: connection refused")).toBe(true);
    expect(fires("  error: connection refused")).toBe(true);
    expect(fires("\nerror: connection refused")).toBe(true);
    expect(fires("\n  error: connection refused")).toBe(true);
    expect(fires("\n\t error: connection refused")).toBe(true);
    expect(fires("result ok\n\nerror: connection refused")).toBe(true);
    expect(fires("result ok\n\n   error: connection refused")).toBe(true);
    expect(fires("result ok\r\n   error: connection refused")).toBe(true);
    // Still quiet: `error` has to start the line, and a colon has to follow.
    expect(fires("no error: nothing failed")).toBe(false);
    expect(fires("the error: handling is fine")).toBe(false);
  });
});
