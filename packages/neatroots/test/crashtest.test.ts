import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { parseChecks } from "../src/checks/registry.js";
import { parseTraceFile } from "../src/ingest/importers/index.js";
import { LayaManager } from "../src/models/laya.js";
import { endpointProblem } from "../src/relay/endpoint.js";
import { regexProblem } from "../src/util/regex.js";
import { checkFromInput } from "../src/server/api-checks.js";
import { freePort, makeRoots, poll, tmpHome, type TestRoots } from "./helpers.js";

// The findings in issue #23 (Crashtest) that the earlier fixes didn't cover.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("re-importing the same HTTP-trace file (#23.4)", () => {
  it("updates its runs instead of adding copies", async () => {
    const t: TestRoots = await makeRoots({ noEngine: true });
    cleanup.push(t.close);
    const file = [{ name: "refund", input: "Refund 1001", children: [{ name: "lookup", kind: "TOOL", tool_name: "lookup" }] }, { name: "search", input: "shoes" }]
      .map((r) => JSON.stringify(r))
      .join("\n");
    t.roots.ingest(parseTraceFile(file, "traces.jsonl", "imported"));
    t.roots.ingest(parseTraceFile(file, "traces.jsonl", "imported"));
    expect(t.roots.store.countRuns()).toBe(2);
    expect(t.roots.store.listRuns({}).map((r) => r.span_count).sort()).toEqual([1, 2]);
  });
});

describe("regular expressions people write (#23.8)", () => {
  it("refuses invalid patterns and ones that can backtrack catastrophically", () => {
    expect(regexProblem("(")).toMatch(/not a valid regular expression/);
    for (const bad of ["(a+)+$", "(a*)*", "(\\w+\\s?)*$", "((ab)+c)+", "(a{1,3})+"]) expect(regexProblem(bad), bad).toMatch(/repeated group/);
    for (const ok of ["sk-[a-z0-9]{20,}", "\\d{4}-\\d{2}", "(ab)+", "(?:foo|bar)+baz", "[(+*]+", "(ab){3}c+", "\\(a+\\)+"]) expect(regexProblem(ok), ok).toBeNull();
  });

  it("refuses saving a match check with a nested repeat, but still loads one already saved", () => {
    const yaml = `
id: slow-match
kind: rule
rule:
  type: match
  pattern: "(a+)+$"
`;
    // Saved before 0.2.9 (in a file): it loads, and runs under the time limit for checks people write.
    const { checks, errors } = parseChecks(yaml);
    expect(errors).toEqual([]);
    expect(checks).toHaveLength(1);
    // Saved now, through the app, the API or a coding agent: refused, naming the field.
    expect(checkFromInput(yaml).error).toMatch(/rule\.pattern.*repeated group/);
    expect(checkFromInput({ check: checks[0] }).error).toMatch(/rule\.pattern.*repeated group/);
    // A pattern that doesn't compile is still refused when it loads.
    expect(parseChecks(yaml.replace('"(a+)+$"', '"("')).errors[0].message).toMatch(/pattern.*not a valid regular expression/);
  });
});

describe("file imports (#23.14)", () => {
  it("refuse a body over 64 MB before reading it", async () => {
    const t = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(t.close);
    const r = await fetch(`${t.url}/api/imports/file`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(65 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/64 MB/);
  });
});

describe("starting Laya (#23.16)", () => {
  it("starts one server when two installs or clicks arrive together", async () => {
    const home = tmpHome();
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, "laya");
    const pids = path.join(home, "pids");
    fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "installed-version"), "test");
    // Stands in for laya-serve: records itself, then answers /health on LAYA_PORT.
    fs.writeFileSync(
      path.join(dir, ".venv", "bin", "laya-serve"),
      `#!/bin/sh\necho $$ >> "${pids}"\nexec "${process.execPath}" -e 'require("http").createServer((q,s)=>s.end("ok")).listen(+process.env.LAYA_PORT,"127.0.0.1")'\n`,
      { mode: 0o755 },
    );
    const cfg = defaultConfig();
    cfg.classifier.laya.port = await freePort();
    cfg.classifier.laya.consent = "yes";
    const laya = new LayaManager(home, cfg.classifier);
    cleanup.push(() => laya.stop());
    await Promise.all([laya.ensure({ install: true }), laya.ensure({ install: true })]);
    await poll(async () => laya.state.state === "running", 15_000);
    expect(fs.readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30_000);
});

describe("the cloud endpoint a key is sent to (#23.21)", () => {
  it("is neatlogs.com over https or localhost, or an https URL marked as trusted", () => {
    expect(endpointProblem("https://ingest.neatlogs.com", false)).toBeNull();
    expect(endpointProblem("http://localhost:4318", false)).toBeNull();
    expect(endpointProblem("http://example.com", true)).toMatch(/plain http/);
    expect(endpointProblem("https://neatlogs.com.example.io", false)).toMatch(/trustEndpoint/);
    expect(endpointProblem("https://neatlogs.example.io", true)).toBeNull();
  });

  it("is checked before a run is forwarded, whatever config.yaml says", async () => {
    const t = await makeRoots({ noEngine: true });
    cleanup.push(t.close);
    t.roots.config.cloud.endpoint = "http://example.com";
    const row = await t.roots.relay.forward([], "test", { apiKey: "nl_test" });
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/plain http/);
  });
});
