import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles } from "../src/checks/offline.js";

const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "neatroots-test-check-errors-"),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const trace = path.join(dir, "trace.json");
fs.writeFileSync(
  trace,
  JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                name: "done",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000010000000",
                attributes: [
                  {
                    key: "neatlogs.span.kind",
                    value: { stringValue: "workflow" },
                  },
                  {
                    key: "neatlogs.workflow.output",
                    value: { stringValue: "complete" },
                  },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  }),
);
const good = `id: clean\nkind: rule\nrule: {type: match, field: name, pattern: never-matches}\n`;
const bad = [
  "not: [valid yaml",
  "id: broken\nkind: rule\nrule: {type: unknown}\n",
  "id: broken\nkind: rule\nrule: {type: match, pattern: '['}\n",
];
function checks(name: string, body: string) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "rule.yaml"), body);
  return folder;
}
function cli(folder: string, json = false, finding = false, extra: string[] = [], files = [trace], nodeArgs: string[] = []) {
  if (finding)
    fs.writeFileSync(
      path.join(folder, "hit.yaml"),
      good.replace("clean", "hit").replace("never-matches", "done"),
    );
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...nodeArgs,
      "src/cli.ts",
      "check",
      ...files,
      "--checks",
      folder,
      ...(json ? ["--json"] : []),
      ...extra,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, NEATROOTS_HOME: path.join(dir, "home") },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}
describe("offline check configuration errors", () => {
  it("keeps exit 2 when writing the JUnit error report also fails", () => {
    const hook = path.join(dir, "fail-report.mjs");
    fs.writeFileSync(hook, 'console.log = () => { throw new Error("report sink unavailable"); };');
    const result = cli(checks("xml-report-failure", good), false, false, ["--junit"], [trace], ["--import", pathToFileURL(hook).href]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not write JUnit report: report sink unavailable");
  });
  it("keeps repeated trace IDs isolated and distinct in JUnit", () => {
    const folder = checks("xml-isolated", good.replace("never-matches", "^bad$"));
    const badTrace = path.join(dir, "bad-trace.json");
    fs.writeFileSync(badTrace, fs.readFileSync(trace, "utf8").replace('"name":"done"', '"name":"bad"').replace('"spanId":"0123456789abcdef"', '"spanId":"fedcba9876543210"'));
    for (const files of [[badTrace, trace], [trace, badTrace]]) {
      const result = cli(folder, false, false, ["--junit", "--only", "clean"], files);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('tests="2" failures="1" errors="0"');
      expect(result.stdout.match(/<failure /g)).toHaveLength(1);
      expect(result.stdout).toContain("fedcba9876543210");
    }
  });

  it("flushes a large JUnit report completely through a pipe", () => {
    const folder = checks("xml-large", good.replace("never-matches", "done") + `title: ${"x".repeat(150000)}\n`);
    const result = cli(folder, false, false, ["--junit", "--only", "clean"]);
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBeGreaterThan(300000);
    expect(result.stdout.trimEnd()).toMatch(/<\/testsuite>\n<\/testsuites>$/);
  });
  it("emits JUnit for passing runs, findings, configuration and input errors", () => {
    for (const [name, body, hit, status] of [
      ["xml-clean", good, false, 0],
      ["xml-hit", good, true, 1],
      ["xml-bad", bad[0], false, 2],
      ["xml-mixed", bad[0], true, 2],
    ] as const) {
      const result = cli(checks(name, body), false, hit, ["--junit"]);
      expect(result.status).toBe(status);
      expect(result.stdout).toMatch(/^<\?xml/);
      expect(result.stdout).toContain(`failures="${hit ? 1 : 0}"`);
      expect(result.stdout).toContain(`errors="${status === 2 ? 1 : 0}"`);
      if (hit) expect(result.stdout).toContain("hit: hit");
    }
    const folder = checks("xml-input", good);
    const malformed = path.join(dir, "malformed.json");
    fs.writeFileSync(malformed, "{invalid");
    for (const extra of [["--only", "missing-rule"], [path.join(dir, "missing.json")], [malformed]]) {
      const result = cli(folder, false, false, ["--junit", ...extra]);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('<error type="check-error"');
    }
    const conflict = cli(folder, true, false, ["--junit"]);
    expect(conflict.status).toBe(2);
    expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("cannot be used together");
  });
  for (const [i, body] of bad.entries()) {
    it(`returns 2 for invalid configuration ${i + 1}, text and JSON`, () => {
      const folder = checks(`invalid-${i}`, body);
      for (const json of [false, true]) {
        const result = cli(folder, json);
        expect(result.status).toBe(2);
        if (json) expect(JSON.parse(result.stdout).errors).toHaveLength(1);
        else expect(result.stdout).toContain("! ");
      }
    });
  }
  it("keeps clean and finding exit codes 0 and 1", () => {
    expect(cli(checks("clean", good)).status).toBe(0);
    expect(cli(checks("finding", good), false, true).status).toBe(1);
  });
  it("keeps configuration error 2 when a valid rule also fires", () => {
    const result = cli(checks("mixed", bad[1]), true, true);
    expect(result.status).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.errors).toHaveLength(1);
    expect(output.runs[0].findings[0].check_id).toBe("hit");
  });
  it("120 labeled saved-trace runs preserve errors and valid clean results", () => {
    const invalid = bad.map((body, i) => checks(`smoke-bad-${i}`, body));
    const valid = checks("smoke-good", good);
    let detected = 0,
      clean = 0;
    for (let i = 0; i < 120; i++) {
      const isBad = i % 2 === 0;
      const result = checkFiles([trace], {
        dirs: [isBad ? invalid[(i / 2) % 3] : valid],
      });
      expect(result.runs[0].findings).toEqual([]);
      if (isBad && result.errors.length === 1) detected++;
      if (!isBad && result.errors.length === 0) clean++;
    }
    expect({ detected, clean }).toEqual({ detected: 60, clean: 60 });
  });
});
