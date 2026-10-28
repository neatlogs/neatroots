import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { log } from "../src/util/log.js";

/**
 * The time limit on a check's pattern is wall clock, so on a loaded machine a pattern that normally
 * takes a fraction of a millisecond can be descheduled past it. These tests drive that first
 * timeout deliberately: `state.timeouts` is how many of the next calls report running out of time.
 * `state.burnMs` makes each call take real time, which is how the retry's own budget is measured.
 */
const state = vi.hoisted(() => ({ timeouts: 0, burnMs: 0, calls: 0 }));

vi.mock("../src/util/regex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/regex.js")>();
  return {
    ...actual,
    testWithin: (re: RegExp, s: string, ms: number) => {
      state.calls++;
      if (state.burnMs > 0) {
        const until = Date.now() + state.burnMs;
        while (Date.now() < until) {
          // A pattern that is slow on every span, rather than one that was descheduled once.
        }
      }
      if (state.timeouts > 0) {
        state.timeouts--;
        return undefined;
      }
      return actual.testWithin(re, s, ms);
    },
  };
});

const { checkFiles } = await import("../src/checks/offline.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-pattern-timeout-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const kv = (key: string, v: string) => ({ key, value: { stringValue: v } });

/** A one-span trace whose span carries the name the rule matches on. */
function traceFile(name: string, spanName: string, traceId: string, spanId: string): string {
  const span = {
    traceId,
    spanId,
    name: spanName,
    kind: 1,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000010000000",
    attributes: [kv("neatroots.span.kind", "llm")],
    status: { code: 1 },
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "check-demo")] }, scopeSpans: [{ scope: { name: "t" }, spans: [span] }] }] }));
  return file;
}

/** One trace holding `count` spans that all carry the name the rule matches on. */
function manySpanFile(name: string, count: number, traceId: string): string {
  const spans = Array.from({ length: count }, (_, i) => ({
    traceId,
    spanId: i.toString(16).padStart(16, "0"),
    name: "bad",
    kind: 1,
    startTimeUnixNano: String(1700000000000000000 + i * 1_000_000),
    endTimeUnixNano: String(1700000000010000000 + i * 1_000_000),
    attributes: [kv("neatroots.span.kind", "llm")],
    status: { code: 1 },
  }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "check-demo")] }, scopeSpans: [{ scope: { name: "t" }, spans }] }] }));
  return file;
}

/** One trace holding a single span whose output is an MCP result with `parts` text items. */
function multiPartFile(name: string, parts: number, traceId: string): string {
  const span = {
    traceId,
    spanId: "f".repeat(16),
    name: "get_weather",
    kind: 1,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000010000000",
    attributes: [
      kv("neatlogs.span.kind", "tool"),
      kv("neatlogs.tool.name", "get_weather"),
      // Each item is its own text to test, and the whole value is one more after them.
      kv("neatlogs.tool.output", JSON.stringify({ content: Array.from({ length: parts }, (_, i) => ({ type: "text", text: `part ${i} bad` })) })),
    ],
    status: { code: 1 },
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "check-demo")] }, scopeSpans: [{ scope: { name: "t" }, spans: [span] }] }] }));
  return file;
}

/** A checks folder holding one match rule. */
function ruleDir(name: string, id: string, pattern: string, field = "name"): string {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.yaml`), `id: ${id}\nkind: rule\nrule: {type: match, field: ${field}, pattern: '${pattern}'}\n`);
  return folder;
}

const evidence = (out: { runs: { findings: { evidence_span_ids: string[] }[] }[] }) => out.runs.map((r) => r.findings.flatMap((f) => f.evidence_span_ids));

describe("a check pattern that runs out of time", () => {
  it("still fires when only the first attempt runs out of time", () => {
    const file = traceFile("once.json", "bad", "1".repeat(32), "a".repeat(16));
    const dirs = [ruleDir("once", "slow-once", "^bad$")];
    state.timeouts = 1;
    // One wall-clock miss is the machine, not the pattern, so the check keeps working.
    expect(evidence(checkFiles([file], { dirs, only: ["slow-once"] }))).toEqual([["a".repeat(16)]]);
  });

  it("is skipped once it runs out of time twice in a row, and only that check", () => {
    const slow = traceFile("slow.json", "bad", "2".repeat(32), "b".repeat(16));
    const other = traceFile("other.json", "bad", "3".repeat(32), "c".repeat(16));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 2;
      // Both attempts miss: this is the pattern the limit exists for, so the check is dropped.
      expect(evidence(checkFiles([slow], { dirs: [ruleDir("slow", "slow-rule", "^bad$")], only: ["slow-rule"] }))).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check slow-rule:");
      // A different check that happens to use the same pattern text is unaffected.
      expect(evidence(checkFiles([other], { dirs: [ruleDir("other", "other-rule", "^bad$")], only: ["other-rule"] }))).toEqual([["c".repeat(16)]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("is skipped when it is genuinely too slow, so the limit still protects the server", () => {
    // (a|aa)+ backtracks for minutes on this input; it cannot finish either attempt.
    const file = traceFile("slow-real.json", "a".repeat(40) + "b", "4".repeat(32), "d".repeat(16));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 0;
      expect(evidence(checkFiles([file], { dirs: [ruleDir("real", "really-slow", "^(a|aa)+$")], only: ["really-slow"] }))).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check really-slow:");
    } finally {
      warn.mockRestore();
    }
  });

  it("spends one retry budget on the whole scan, not one on every span", () => {
    // A pattern that is slow on every span rather than descheduled once. The retry has 250 ms for
    // the scan, so it can only get through a few of the twenty spans; a per-span budget would test
    // all twenty and stall for 20 x 40 ms.
    const file = manySpanFile("many.json", 20, "5".repeat(32));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 1;
      state.burnMs = 40;
      state.calls = 0;
      const out = checkFiles([file], { dirs: [ruleDir("many", "slow-every-span", "^bad$")], only: ["slow-every-span"] });
      // Twenty spans plus the first attempt would be 21 calls; the budget stops it around eight.
      expect(state.calls).toBeLessThanOrEqual(12);
      expect(evidence(out)).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check slow-every-span:");
    } finally {
      state.burnMs = 0;
      warn.mockRestore();
    }
  });

  it("spends the retry budget across one span's text parts, not on each of them", () => {
    // An MCP result carries several `content[].text` items, and each is its own text to test. The
    // budget has to be worked out per value: handing every item the whole remainder lets one span
    // spend it many times over.
    const file = multiPartFile("parts.json", 12, "6".repeat(32));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 1;
      state.burnMs = 40;
      state.calls = 0;
      const out = checkFiles([file], { dirs: [ruleDir("parts", "slow-parts", "^bad$", "output")], only: ["slow-parts"] });
      // 12 text items plus the whole value, plus the first attempt: 14 calls if each got the full
      // remainder. The budget stops it around eight.
      expect(state.calls).toBeLessThanOrEqual(12);
      expect(evidence(out)).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check slow-parts:");
    } finally {
      state.burnMs = 0;
      warn.mockRestore();
    }
  });
});
