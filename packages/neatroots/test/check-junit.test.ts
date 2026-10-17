import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles, escapeXml, formatJUnit, formatJUnitError } from "../src/checks/offline.js";
import { hex } from "./helpers.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-junit-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const kv = (key: string, v: string | number) => ({ key, value: { stringValue: String(v) } });

function trace(options: {
  toolName?: string;
  workflowName?: string;
  repeatTool?: number;
} = {}): string {
  const t = hex(16);
  const root = hex(8);
  const n = 1_700_000_000_000_000_000;
  const repeat = options.repeatTool ?? 1;
  const spans: any[] = [];
  for (let i = 0; i < repeat; i++) {
    const start = n + i * 300_000_000;
    spans.push({
      traceId: t,
      spanId: hex(8),
      parentSpanId: root,
      name: options.toolName ?? "search",
      kind: 1,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 200_000_000),
      attributes: [
        kv("neatlogs.span.kind", "tool"),
        kv("neatlogs.tool.name", options.toolName ?? "search"),
        kv("neatlogs.tool.input", '{"q":"x"}'),
        kv("neatlogs.tool.output", "ok"),
      ],
      status: {},
    });
  }
  spans.push({
    traceId: t,
    spanId: root,
    parentSpanId: "",
    name: options.workflowName ?? "agent",
    kind: 1,
    startTimeUnixNano: String(n - 100_000_000),
    endTimeUnixNano: String(n + 5_000_000_000),
    attributes: [kv("neatlogs.span.kind", "workflow"), kv("neatlogs.workflow.output", "Done.")],
    status: {},
  });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", "junit-test")] },
        scopeSpans: [{ scope: { name: "test" }, spans }],
      },
    ],
  });
}

function writeTrace(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function runCli(args: string[], homeDir?: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "check", ...args],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, NEATROOTS_HOME: homeDir ?? path.join(dir, "home") },
      encoding: "utf8",
    },
  );
}

describe("JUnit XML output for offline trace checks", () => {
  it("escapes special XML entities correctly and strips control chars", () => {
    expect(escapeXml(`a & b < c > d "e" 'f'\x00`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;",
    );
  });

  it("produces clean <testcase> for a passing run", () => {
    const cleanFile = writeTrace("clean.json", trace({ repeatTool: 1 }));
    const r = checkFiles([cleanFile]);
    const xml = formatJUnit(r);

    expect(xml).toContain("<testsuites>");
    expect(xml).toContain('<testsuite name="neatroots check" tests="1" failures="0" errors="0"');
    expect(xml).toContain(`classname="${cleanFile}/junit-test"`);
    expect(xml).toContain(`name="${r.runs[0].trace_id} agent"`);
    expect(xml).not.toContain("<failure");
    expect(xml).not.toContain("<error");
  });

  it("produces <failure> containing check IDs and evidence span IDs", () => {
    const loopFile = writeTrace("loop.json", trace({ toolName: "search", repeatTool: 4 }));
    const r = checkFiles([loopFile]);
    const xml = formatJUnit(r);

    expect(xml).toContain('<testsuite name="neatroots check" tests="1" failures="1" errors="0"');
    expect(xml).toContain('<failure message="[repeated-tool-call] Same tool called repeatedly with identical arguments">');
    expect(xml).toContain("check_id: repeated-tool-call");
    expect(xml).toContain("evidence_span_ids:");
    expect(xml).toContain("</failure>");
  });

  it("handles multiple runs with mixed outcomes", () => {
    const cleanFile = writeTrace("multi-clean.json", trace({ repeatTool: 1 }));
    const loopFile = writeTrace("multi-loop.json", trace({ toolName: "search", repeatTool: 4 }));
    const r = checkFiles([cleanFile, loopFile]);
    const xml = formatJUnit(r);

    expect(xml).toContain('tests="2" failures="1" errors="0"');
    expect(xml).toContain(`classname="${cleanFile}/junit-test"`);
    expect(xml).toContain(`classname="${loopFile}/junit-test"`);
  });

  it("properly escapes XML special entities in rule titles and evidence", () => {
    const checkFolder = path.join(dir, "escaped-checks");
    fs.mkdirSync(checkFolder, { recursive: true });
    fs.writeFileSync(
      path.join(checkFolder, "rule.yaml"),
      `id: xml-spec\nkind: rule\ntitle: "Need <valid> & 'clean' \\"quotes\\""\nrule: {type: match, field: name, pattern: search}\n`,
    );
    const traceFile = writeTrace("escape-test.json", trace({ toolName: "search", repeatTool: 1 }));
    const r = checkFiles([traceFile], { dirs: [checkFolder] });
    const xml = formatJUnit(r);

    expect(xml).toContain("title: Need &lt;valid&gt; &amp; &apos;clean&apos; &quot;quotes&quot;");
    expect(xml).toContain('message="[xml-spec] Need &lt;valid&gt; &amp; &apos;clean&apos; &quot;quotes&quot;"');
  });

  it("formats configuration errors as <error> elements", () => {
    const badCheckFolder = path.join(dir, "bad-checks");
    fs.mkdirSync(badCheckFolder, { recursive: true });
    fs.writeFileSync(path.join(badCheckFolder, "broken.yaml"), "invalid: [yaml");
    const traceFile = writeTrace("config-err.json", trace({ repeatTool: 1 }));
    const r = checkFiles([traceFile], { dirs: [badCheckFolder] });
    const xml = formatJUnit(r);

    expect(xml).toContain('tests="2" failures="0" errors="1"');
    expect(xml).toContain('<testcase classname="config"');
    expect(xml).toContain("<error message=");
  });

  it("formats unhandled error via formatJUnitError", () => {
    const xml = formatJUnitError(new Error("File corrupt <bad> & invalid"));
    expect(xml).toContain('tests="1" failures="0" errors="1"');
    expect(xml).toContain('message="File corrupt &lt;bad&gt; &amp; invalid"');
  });

  it("CLI: supports --format junit and exits with appropriate codes", () => {
    const cleanFile = writeTrace("cli-clean.json", trace({ repeatTool: 1 }));
    const loopFile = writeTrace("cli-loop.json", trace({ toolName: "search", repeatTool: 4 }));

    const resClean = runCli([cleanFile, "--format", "junit"]);
    expect(resClean.status).toBe(0);
    expect(resClean.stdout).toContain('<testsuite name="neatroots check" tests="1" failures="0" errors="0"');

    const resLoop = runCli([loopFile, "--format", "junit"]);
    expect(resLoop.status).toBe(1);
    expect(resLoop.stdout).toContain('<testsuite name="neatroots check" tests="1" failures="1" errors="0"');
    expect(resLoop.stdout).toContain("<failure");
  });

  it("CLI: supports --junit <path> file output", () => {
    const cleanFile = writeTrace("cli-file.json", trace({ repeatTool: 1 }));
    const reportPath = path.join(dir, "reports", "junit.xml");
    const res = runCli([cleanFile, "--junit", reportPath]);

    expect(res.status).toBe(0);
    expect(fs.existsSync(reportPath)).toBe(true);
    const content = fs.readFileSync(reportPath, "utf8");
    expect(content).toContain('<testsuite name="neatroots check" tests="1" failures="0" errors="0"');
  });
});
