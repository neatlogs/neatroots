import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterAll, describe, expect, it, vi } from "vitest";
import { formatFixtureReport, testCheckFixtures } from "../src/checks/fixtures.js";
import { checkFiles } from "../src/checks/offline.js";
import * as regex from "../src/util/regex.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-check-fixtures-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const rule = `id: detect-marker
kind: rule
rule:
  type: match
  field: output
  pattern: marker
`;

function trace(traceId: string, output: string): object {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: "0123456789abcdef",
                name: "agent",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000010000000",
                attributes: [
                  { key: "neatlogs.span.kind", value: { stringValue: "workflow" } },
                  { key: "neatlogs.workflow.output", value: { stringValue: output } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

interface SuiteOptions {
  fixtures?: { id: string; trace: string; trace_id?: string; expected: string[] }[];
  rules?: string[];
  check?: string;
  extension?: ".yaml" | ".json";
  rawManifest?: string;
}

function suite(name: string, opts: SuiteOptions = {}) {
  const root = path.join(dir, name);
  const checks = path.join(root, "checks");
  const traces = path.join(root, "traces");
  fs.mkdirSync(checks, { recursive: true });
  fs.mkdirSync(traces, { recursive: true });
  fs.writeFileSync(path.join(checks, "rule.yaml"), opts.check ?? rule);
  fs.writeFileSync(path.join(traces, "hit.json"), JSON.stringify(trace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "marker found")));
  fs.writeFileSync(path.join(traces, "clean.json"), JSON.stringify(trace("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "all clear")));
  const data = {
    version: 1,
    checks: "./checks",
    rules: opts.rules ?? ["detect-marker"],
    fixtures: opts.fixtures ?? [{ id: "hit", trace: "./traces/hit.json", expected: ["detect-marker"] }],
  };
  const manifest = path.join(root, `manifest${opts.extension ?? ".yaml"}`);
  fs.writeFileSync(manifest, opts.rawManifest ?? (opts.extension === ".json" ? JSON.stringify(data, null, 2) : YAML.stringify(data)));
  return { root, checks, traces, manifest };
}

function cli(manifest: string, options: { json?: boolean; home?: string } = {}) {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "checks", "test", manifest, ...(options.json ? ["--json"] : [])],
    {
      cwd: packageDir,
      env: { ...process.env, NEATROOTS_HOME: options.home ?? path.join(dir, "isolated-home") },
      encoding: "utf8",
    },
  );
}

describe("check fixture suites", () => {
  it("runs fixture-supplied patterns through the bounded regex evaluator", () => {
    const sample = suite("bounded-regex");
    const bounded = vi.spyOn(regex, "testWithin");
    try {
      const report = testCheckFixtures(sample.manifest);
      expect(report.status).toBe("passed");
      expect(bounded).toHaveBeenCalled();
      expect(bounded.mock.calls.every(([pattern, , timeout]) => pattern.source === "marker" && timeout === 50)).toBe(true);
    } finally {
      bounded.mockRestore();
    }
  });

  it("ignores a personal YAML-named directory while ordinary offline checks still load personal sources", () => {
    const s = suite("ambient-directory");
    const home = path.join(dir, "ambient-directory-home");
    fs.mkdirSync(path.join(home, "checks", "draft.yaml"), { recursive: true });
    vi.stubEnv("NEATROOTS_HOME", home);
    try {
      expect(testCheckFixtures(s.manifest)).toMatchObject({
        exit_code: 0,
        errors: [],
        fixtures: [{ actual: ["detect-marker"] }],
      });
      const ordinary = checkFiles([path.join(s.traces, "hit.json")], { dirs: [s.checks], only: ["detect-marker"] });
      expect(ordinary.errors).toContain(`${path.join(home, "checks", "draft.yaml")}: EISDIR`);
      expect(ordinary.runs[0].findings.map((finding) => finding.check_id)).toEqual(["detect-marker"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not read an unavailable shipped check library when running declared fixture rules", () => {
    const s = suite("unreadable-library");
    const library = fileURLToPath(new URL("../library", import.meta.url));
    const read = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (path.dirname(String(args[0])) === library) {
        throw Object.assign(new Error("library access denied"), { code: "EACCES" });
      }
      return Reflect.apply(read, fs, args);
    });
    try {
      expect(testCheckFixtures(s.manifest)).toMatchObject({ exit_code: 0, errors: [], fixtures: [{ actual: ["detect-marker"] }] });
      const ordinary = checkFiles([path.join(s.traces, "hit.json")]);
      expect(ordinary.errors).toContain(`${path.join(library, "rules.yaml")}: EACCES`);
    } finally {
      spy.mockRestore();
    }
  });

  it("runs the self-contained example using paths relative to its manifest", () => {
    const manifest = fileURLToPath(new URL("../../../examples/check-fixtures/manifest.yaml", import.meta.url));
    const report = testCheckFixtures(manifest);
    expect(report).toMatchObject({ exit_code: 0, status: "passed", rules: ["demo-secret-output"] });
    expect(report.fixtures.map((fixture) => fixture.actual)).toEqual([["demo-secret-output"], []]);
  });

  it("reports missed and unexpected rule findings as assertion mismatches", () => {
    const s = suite("mismatches", {
      fixtures: [
        { id: "missed", trace: "./traces/clean.json", expected: ["detect-marker"] },
        { id: "unexpected", trace: "./traces/hit.json", expected: [] },
      ],
    });
    const report = testCheckFixtures(s.manifest);
    expect(report.exit_code).toBe(1);
    expect(report.fixtures.map((fixture) => fixture.missing)).toEqual([["detect-marker"], []]);
    expect(report.fixtures.map((fixture) => fixture.unexpected)).toEqual([[], ["detect-marker"]]);
    expect(formatFixtureReport(report)).toContain("missed: detect-marker");
    expect(formatFixtureReport(report)).toContain("unexpected: detect-marker");
  });

  it("isolates fixtures that reuse the same trace id", () => {
    const s = suite("reused-trace-id", {
      fixtures: [
        { id: "positive", trace: "./traces/positive.json", expected: ["detect-marker"] },
        { id: "negative", trace: "./traces/negative.json", expected: [] },
      ],
    });
    const sharedId = "cccccccccccccccccccccccccccccccc";
    fs.writeFileSync(path.join(s.traces, "positive.json"), JSON.stringify(trace(sharedId, "marker")));
    fs.writeFileSync(path.join(s.traces, "negative.json"), JSON.stringify(trace(sharedId, "clean")));
    const report = testCheckFixtures(s.manifest);
    expect(report.exit_code).toBe(0);
    expect(report.fixtures.map((fixture) => fixture.trace_id)).toEqual([sharedId, sharedId]);
    expect(report.fixtures.map((fixture) => fixture.actual)).toEqual([["detect-marker"], []]);
  });

  it("requires trace_id to disambiguate a file that imports multiple traces", () => {
    const multi = suite("multi-trace", {
      fixtures: [{ id: "select", trace: "./traces/multi.json", expected: ["detect-marker"] }],
    });
    const selected = "dddddddddddddddddddddddddddddddd";
    fs.writeFileSync(
      path.join(multi.traces, "multi.json"),
      JSON.stringify([trace("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "clean"), trace(selected, "marker")]),
    );
    expect(testCheckFixtures(multi.manifest)).toMatchObject({ exit_code: 2, errors: [expect.stringContaining("set trace_id")] });

    const manifest = YAML.parse(fs.readFileSync(multi.manifest, "utf8"));
    manifest.fixtures[0].trace_id = selected;
    fs.writeFileSync(multi.manifest, YAML.stringify(manifest));
    expect(testCheckFixtures(multi.manifest)).toMatchObject({ exit_code: 0, fixtures: [{ trace_id: selected }] });
  });

  it("accepts strict JSON manifests and rejects malformed, mistyped and empty suites", () => {
    const json = suite("json-manifest", { extension: ".json" });
    expect(testCheckFixtures(json.manifest).exit_code).toBe(0);

    const malformed = suite("malformed-json", { extension: ".json", rawManifest: "{ nope" });
    expect(testCheckFixtures(malformed.manifest).exit_code).toBe(2);

    const typo = suite("unknown-field", {
      rawManifest: YAML.stringify({ version: 1, checks: "./checks", rules: ["detect-marker"], fixtures: [], fixtuers: [] }),
    });
    expect(testCheckFixtures(typo.manifest)).toMatchObject({ exit_code: 2, errors: [expect.stringContaining("fixtuers")] });

    for (const [name, rules, fixtures] of [
      ["empty-rules", [], [{ id: "hit", trace: "./traces/hit.json", expected: [] }]],
      ["empty-fixtures", ["detect-marker"], []],
    ] as const) {
      const empty = suite(name, { rules: [...rules], fixtures: [...fixtures] });
      expect(testCheckFixtures(empty.manifest).exit_code).toBe(2);
    }
  });

  it("rejects unknown ids, question checks and expected ids outside the declared scope", () => {
    const unknown = suite("unknown-rule", {
      rules: ["misspelled-rule"],
      fixtures: [{ id: "hit", trace: "./traces/hit.json", expected: [] }],
    });
    expect(testCheckFixtures(unknown.manifest)).toMatchObject({ exit_code: 2, errors: [expect.stringContaining("unknown rule id")] });

    const outside = suite("outside-scope", {
      fixtures: [{ id: "hit", trace: "./traces/hit.json", expected: ["other-rule"] }],
    });
    expect(testCheckFixtures(outside.manifest)).toMatchObject({ exit_code: 2, errors: [expect.stringContaining("outside rules scope")] });

    const question = suite("question-id", {
      check: `id: human-question\nkind: yes_no\nask: Did the agent do the unsafe thing?\n`,
      rules: ["human-question"],
      fixtures: [{ id: "hit", trace: "./traces/hit.json", expected: [] }],
    });
    expect(testCheckFixtures(question.manifest)).toMatchObject({ exit_code: 2, errors: [expect.stringContaining("question check id is not a rule")] });

    const malformedCheck = suite("malformed-check", {
      check: "id: detect-marker\nkind: rule\nrule:\n  type: invalid\n",
    });
    expect(testCheckFixtures(malformedCheck.manifest)).toMatchObject({ exit_code: 2, status: "error" });
  });

  it("returns configuration errors for missing check and trace files or invalid traces", () => {
    const missingTrace = suite("missing-trace", {
      fixtures: [{ id: "missing", trace: "./traces/nope.json", expected: [] }],
    });
    const entriesBefore = fs.readdirSync(missingTrace.root, { recursive: true }).sort();
    const expectedError = "fixture missing: trace path is not a file: ./traces/nope.json";
    const expectedReport = { exit_code: 2, status: "error", fixtures: [], errors: [expectedError] };
    expect(testCheckFixtures(missingTrace.manifest)).toMatchObject(expectedReport);
    const missingJson = cli(missingTrace.manifest, { json: true });
    expect(missingJson.status).toBe(2);
    expect(JSON.parse(missingJson.stdout)).toMatchObject(expectedReport);
    const missingHuman = cli(missingTrace.manifest);
    expect(missingHuman.status).toBe(2);
    expect(missingHuman.stdout).toContain(expectedError);
    expect(missingHuman.stdout).not.toContain("ENOENT");
    expect(fs.readdirSync(missingTrace.root, { recursive: true }).sort()).toEqual(entriesBefore);
    expect(fs.existsSync(path.join(missingTrace.traces, "nope.json"))).toBe(false);

    const badTrace = suite("bad-trace", {
      fixtures: [{ id: "bad", trace: "./traces/bad.json", expected: [] }],
    });
    fs.writeFileSync(path.join(badTrace.traces, "bad.json"), "not json");
    expect(testCheckFixtures(badTrace.manifest)).toMatchObject({ exit_code: 2, status: "error" });

    const missingChecks = suite("missing-checks");
    fs.rmSync(missingChecks.checks, { recursive: true, force: true });
    expect(testCheckFixtures(missingChecks.manifest).exit_code).toBe(2);
  });

  it("scopes evaluation to declared custom checks and returns CLI exits 0, 1 and 2", () => {
    const home = path.join(dir, "ambient-home");
    fs.mkdirSync(path.join(home, "checks"), { recursive: true });
    fs.writeFileSync(path.join(home, "checks", "ambient.yaml"), rule.replace("detect-marker", "ambient-only"));
    fs.writeFileSync(path.join(home, "checks", "broken.yaml"), "id: broken\nkind: rule\nrule:\n  type: unknown\n");

    const passing = suite("cli-pass");
    const pass = cli(passing.manifest, { home });
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain("1/1 fixtures passed");

    const mismatch = suite("cli-mismatch", {
      fixtures: [{ id: "missed", trace: "./traces/clean.json", expected: ["detect-marker"] }],
    });
    const failed = cli(mismatch.manifest, { json: true });
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "failed", exit_code: 1, fixtures: [{ missing: ["detect-marker"] }] });

    const ambient = suite("cli-ambient", {
      rules: ["ambient-only"],
      fixtures: [{ id: "hit", trace: "./traces/hit.json", expected: [] }],
    });
    const invalid = cli(ambient.manifest, { json: true, home });
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: "error", exit_code: 2, errors: [expect.stringContaining("unknown rule id")] });

    const large = suite("cli-large-report", {
      fixtures: Array.from({ length: 512 }, (_, index) => ({
        id: `case-${String(index).padStart(4, "0")}`,
        trace: "./traces/clean.json",
        expected: [],
      })),
    });
    const largeReport = cli(large.manifest, { json: true });
    expect(largeReport.status).toBe(0);
    expect(largeReport.stdout.length).toBeGreaterThan(64 * 1024);
    const parsedLargeReport = JSON.parse(largeReport.stdout);
    expect(parsedLargeReport.fixtures).toHaveLength(512);
    expect(parsedLargeReport.fixtures.at(-1).id).toBe("case-0511");
  }, 120_000);
});
