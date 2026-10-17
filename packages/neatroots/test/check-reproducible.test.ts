import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkFiles, recordOrVerifyCheckManifest } from "../src/checks/offline.js";
import * as ruleEvaluation from "../src/checks/rules.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const dir = fs.mkdtempSync(path.join(packageRoot, ".tmp-check-repro-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const trace = path.join(dir, "trace.json");
fs.writeFileSync(trace, JSON.stringify({
  resourceSpans: [{
    resource: { attributes: [] },
    scopeSpans: [{ spans: [{
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      name: "done",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000010000000",
      attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "workflow" } }],
      status: { code: 1 },
    }] }],
  }],
}));

const repoRules = `checks:
  - id: repo-clean
    kind: rule
    rule: {type: match, field: name, pattern: never-matches}
  - id: repo-other
    kind: rule
    rule: {type: match, field: name, pattern: also-never}
`;
const personalRule = `id: personal-only
kind: rule
rule: {type: match, field: name, pattern: done}
`;

function writeCheck(dirName: string, name: string, body: string): string {
  const folder = path.join(dir, dirName);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), body);
  return folder;
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "check", trace, ...args], {
    cwd: packageRoot,
    env: { ...process.env, NEATROOTS_HOME: home },
    encoding: "utf8",
  });
}

describe("reproducible offline checks", () => {
  it("names the actual working-directory boundary when the CLI runs in a repository subdirectory", () => {
    const checks = writeCheck("cwd-boundary/checks", "rules.yaml", repoRules);
    const cwd = path.join(dir, "cwd-boundary", "subdir");
    fs.mkdirSync(cwd, { recursive: true });
    const link = path.join(cwd, "linked-checks");
    fs.symlinkSync(checks, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const local = path.join(cwd, "checks");
      fs.mkdirSync(local);
      fs.writeFileSync(path.join(local, "rules.yaml"), repoRules);
      for (const [folder, lock] of [["../checks", "checks.lock.json"], ["linked-checks", "checks.lock.json"], ["checks", "../checks.lock.json"], ["checks", "linked-checks/nested/checks.lock.json"]]) {
        const result = spawnSync(process.execPath, ["--import", "tsx", path.join(packageRoot, "src/cli.ts"), "check", trace,
          "--checks", folder, "--reproducible", "--lockfile", lock], {
          cwd, env: { ...process.env, NEATROOTS_HOME: path.join(dir, "boundary-home") }, encoding: "utf8",
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`must be inside the current working directory (${cwd})`);
        expect(result.stderr).not.toContain("current repository");
      }
      expect(fs.existsSync(path.join(cwd, "checks.lock.json"))).toBe(false);
      expect(fs.existsSync(path.join(checks, "nested"))).toBe(false);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it.each([false, true])("keeps repository rules under timed evaluation (reproducible=%s)", (reproducible) => {
    const checks = writeCheck(`timed-${reproducible}`, "rules.yaml", repoRules.replace("repo-clean", "repo-z").replace("repo-other", "repo-a"));
    // Observe real evaluation without stubbing it: retaining a rule's source across sorting
    // is what keeps main's regex time limit enabled for repository checks in both modes.
    const evaluate = vi.spyOn(ruleEvaluation, "evaluateRule");
    try {
      const result = checkFiles([trace], { dirs: [checks], only: ["repo-a", "repo-z"], reproducible });
      expect(result.runs[0].findings).toEqual([]);
      expect(evaluate.mock.calls).toHaveLength(2);
      expect(evaluate.mock.calls.map((args) => [args[0].id, args[4]])).toEqual(
        (reproducible ? ["repo-a", "repo-z"] : ["repo-z", "repo-a"]).map((id) => [id, true]),
      );
    } finally {
      evaluate.mockRestore();
    }
  });

  it("loads only repository checks and creates a stable lock that rejects drift", () => {
    const checks = writeCheck("repo", "rules.yaml", repoRules);
    const home = path.join(dir, "home");
    writeCheck(path.join("home", "checks"), "personal.yaml", personalRule);
    const lock = path.join(dir, "checks.lock.json");
    const args = ["--checks", checks, "--reproducible", "--lockfile", lock, "--only", "repo-clean", "--json"];

    const first = runCli(args, home);
    expect(first.status).toBe(0);
    const firstJson = JSON.parse(first.stdout);
    expect(firstJson.rules).toEqual(["repo-clean"]);
    const source = path.relative(packageRoot, path.join(checks, "rules.yaml")).split(path.sep).join("/");
    expect(firstJson.check_manifest).toMatchObject({
      version: 1,
      checks: [
        { id: "repo-clean", kind: "rule", source, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { id: "repo-other", kind: "rule", source, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
      rules: ["repo-clean"],
    });
    expect(firstJson.check_manifest.checks.some((check: { id: string }) => check.id === "personal-only")).toBe(false);
    expect(firstJson.check_lockfile).toBe("created");
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(firstJson.check_manifest);

    const selection = checkFiles([trace], { dirs: [checks], only: ["repo-other", "repo-clean"], reproducible: true });
    expect(selection.rules).toEqual(["repo-clean", "repo-other"]);
    expect(recordOrVerifyCheckManifest(lock, firstJson.check_manifest)).toBe("matched");
    const changed = {
      ...firstJson.check_manifest,
      checks: firstJson.check_manifest.checks.map((check: { id: string; sha256: string }) =>
        check.id === "repo-clean" ? { ...check, sha256: "0".repeat(64) } : check),
    };
    expect(() => recordOrVerifyCheckManifest(lock, changed)).toThrow(/differs from .*checks\.lock\.json/);
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(firstJson.check_manifest);

    fs.writeFileSync(path.join(checks, "rules.yaml"), repoRules.replace("never-matches", "now-matches"));
    const drift = runCli(args, home);
    expect(drift.status).toBe(2);
    expect(drift.stderr).toMatch(/differs from .*checks\.lock\.json/);
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(firstJson.check_manifest);
  }, 90_000);

  it("requires repository directories and refuses paths outside the working tree", () => {
    expect(() => checkFiles([trace], { reproducible: true })).toThrow(/requires at least one --checks directory/);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-outside-checks-"));
    try {
      fs.writeFileSync(path.join(outside, "rule.yaml"), repoRules);
      expect(() => checkFiles([trace], { dirs: [outside], reproducible: true })).toThrow(`must be inside the current working directory (${path.resolve(process.cwd())})`);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects external directories and lock parents reached through symlinks", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-linked-checks-"));
    const link = path.join(dir, "external-link");
    try {
      fs.writeFileSync(path.join(outside, "rule.yaml"), repoRules);
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      expect(() => checkFiles([trace], { dirs: [link], reproducible: true })).toThrow(`must be inside the current working directory (${path.resolve(process.cwd())})`);
      const manifest = { version: 1 as const, directories: [], checks: [], rules: [] };
      expect(() => recordOrVerifyCheckManifest(path.join(link, "nested", "checks.lock.json"), manifest)).toThrow(`must be inside the current working directory (${path.resolve(process.cwd())})`);
      expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
    } finally {
      if (fs.existsSync(link)) fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("uses later explicit directories to override duplicate ids", () => {
    const first = writeCheck("first", "override.yaml", "id: override\nkind: rule\nrule: {type: match, field: name, pattern: never}\n");
    const later = writeCheck("later", "override.yaml", "id: override\nkind: rule\nrule: {type: match, field: name, pattern: done}\n");
    const result = checkFiles([trace], { dirs: [first, later], only: ["override"], reproducible: true });
    expect(result.runs[0].findings.map((finding) => finding.check_id)).toEqual(["override"]);
    expect(result.manifest?.checks).toMatchObject([{
      id: "override",
      source: path.relative(process.cwd(), path.join(later, "override.yaml")).split(path.sep).join("/"),
    }]);
  });
});
