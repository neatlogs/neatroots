import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { checkFiles } from "./offline.js";
import { parseChecks } from "./registry.js";
import { isRule, type RuleCheck } from "./types.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "use lowercase letters, digits, dot, dash or underscore");
const relativePath = z.string().min(1).refine(
  (value) => !path.isAbsolute(value) && !path.win32.isAbsolute(value),
  "must be relative to the manifest",
);

const Fixture = z
  .object({
    id,
    trace: relativePath,
    trace_id: z.string().min(1).optional(),
    /** Exact set of rule ids expected to fire. An empty list means none should fire. */
    expected: z.array(id),
  })
  .strict();

const Manifest = z
  .object({
    version: z.literal(1),
    checks: relativePath,
    /** All rule checks this suite evaluates. */
    rules: z.array(id).min(1),
    fixtures: z.array(Fixture).min(1),
  })
  .strict();

export interface FixtureCaseResult {
  id: string;
  trace: string;
  trace_id: string;
  expected: string[];
  actual: string[];
  missing: string[];
  unexpected: string[];
  passed: boolean;
}

export interface FixtureSuiteReport {
  manifest: string;
  status: "passed" | "failed" | "error";
  exit_code: 0 | 1 | 2;
  rules: string[];
  fixtures: FixtureCaseResult[];
  errors: string[];
}

function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ");
}

function parseManifest(file: string): z.infer<typeof Manifest> {
  const extension = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, "utf8");
  let value: unknown;
  if (extension === ".json") value = JSON.parse(text);
  else if (extension === ".yaml" || extension === ".yml") {
    const document = YAML.parseDocument(text);
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
    value = document.toJS();
  } else throw new Error("manifest must use .json, .yaml or .yml");

  const parsed = Manifest.safeParse(value);
  if (!parsed.success) throw new Error(issueText(parsed.error));
  const fixtureIds = parsed.data.fixtures.map((fixture) => fixture.id);
  const ruleIds = parsed.data.rules;
  if (new Set(fixtureIds).size !== fixtureIds.length) throw new Error("fixture ids must be unique");
  if (new Set(ruleIds).size !== ruleIds.length) throw new Error("rules must not contain duplicate ids");
  for (const fixture of parsed.data.fixtures) {
    if (new Set(fixture.expected).size !== fixture.expected.length) throw new Error(`fixture ${fixture.id}: expected must not contain duplicate ids`);
    const outsideScope = fixture.expected.filter((ruleId) => !ruleIds.includes(ruleId));
    if (outsideScope.length) throw new Error(`fixture ${fixture.id}: expected rule id(s) outside rules scope: ${outsideScope.join(", ")}`);
  }
  return parsed.data;
}

function ensureInputs(manifestPath: string, manifest: z.infer<typeof Manifest>): { checkDir: string; fixturePaths: Map<string, string> } {
  const base = path.dirname(manifestPath);
  const checkDir = path.resolve(base, manifest.checks);
  if (!fs.statSync(checkDir).isDirectory()) throw new Error(`checks path is not a directory: ${manifest.checks}`);
  if (!fs.readdirSync(checkDir).some((entry) => /\.ya?ml$/i.test(entry) && fs.statSync(path.join(checkDir, entry)).isFile())) {
    throw new Error(`checks directory has no YAML check files: ${manifest.checks}`);
  }
  const fixturePaths = new Map<string, string>();
  for (const fixture of manifest.fixtures) {
    const tracePath = path.resolve(base, fixture.trace);
    if (!fs.statSync(tracePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`fixture ${fixture.id}: trace path is not a file: ${fixture.trace}`);
    fixturePaths.set(fixture.id, tracePath);
  }
  return { checkDir, fixturePaths };
}

function validateRules(checkDir: string, ruleIds: string[]): RuleCheck[] {
  const loaded = new Map<string, ReturnType<typeof parseChecks>["checks"][number]>();
  for (const file of fs.readdirSync(checkDir).filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
    const filePath = path.join(checkDir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    const parsed = parseChecks(fs.readFileSync(filePath, "utf8"));
    if (parsed.errors.length) throw new Error(`${filePath}: ${parsed.errors.map((entry) => entry.message).join("; ")}`);
    for (const check of parsed.checks) {
      if (loaded.has(check.id)) throw new Error(`duplicate custom check id: ${check.id}`);
      loaded.set(check.id, check);
    }
  }
  return ruleIds.map((ruleId) => {
    const check = loaded.get(ruleId);
    if (!check) throw new Error(`unknown rule id in rules: ${ruleId}`);
    if (!isRule(check)) throw new Error(`question check id is not a rule: ${ruleId}`);
    if (check.enabled === false) throw new Error(`disabled rule cannot be tested: ${ruleId}`);
    return check;
  });
}

function errorReport(manifest: string, message: string): FixtureSuiteReport {
  return { manifest, status: "error", exit_code: 2, rules: [], fixtures: [], errors: [message] };
}

/** Run a fixture manifest through the same offline trace importer and rule evaluator as `neatroots check`. */
export function testCheckFixtures(manifestFile: string): FixtureSuiteReport {
  const manifestPath = path.resolve(manifestFile);
  try {
    const manifest = parseManifest(manifestPath);
    const { checkDir, fixturePaths } = ensureInputs(manifestPath, manifest);
    const rules = validateRules(checkDir, manifest.rules);
    const fixtures: FixtureCaseResult[] = [];
    for (const fixture of manifest.fixtures) {
      const tracePath = fixturePaths.get(fixture.id)!;
      const result = checkFiles([tracePath], {
        explicitRules: rules,
      });
      if (!result.runs.length) throw new Error(`fixture ${fixture.id}: trace file imported no runs`);

      const matches = fixture.trace_id === undefined
        ? result.runs
        : result.runs.filter((run) => run.trace_id === fixture.trace_id);
      if (fixture.trace_id !== undefined && matches.length === 0) {
        throw new Error(`fixture ${fixture.id}: trace_id ${fixture.trace_id} was not found in ${fixture.trace}`);
      }
      if (matches.length !== 1) {
        throw new Error(`fixture ${fixture.id}: ${result.runs.length} traces imported; set trace_id to select exactly one`);
      }

      const expected = [...fixture.expected].sort();
      const actual = [...new Set(matches[0].findings.map((finding) => finding.check_id))].sort();
      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      const missing = expected.filter((ruleId) => !actualSet.has(ruleId));
      const unexpected = actual.filter((ruleId) => !expectedSet.has(ruleId));
      fixtures.push({
        id: fixture.id,
        trace: fixture.trace,
        trace_id: matches[0].trace_id,
        expected,
        actual,
        missing,
        unexpected,
        passed: missing.length === 0 && unexpected.length === 0,
      });
    }
    const passed = fixtures.every((fixture) => fixture.passed);
    return {
      manifest: manifestFile,
      status: passed ? "passed" : "failed",
      exit_code: passed ? 0 : 1,
      rules: manifest.rules,
      fixtures,
      errors: [],
    };
  } catch (error) {
    return errorReport(manifestFile, error instanceof Error ? error.message : String(error));
  }
}

export function formatFixtureReport(report: FixtureSuiteReport): string {
  const lines = [`Checks fixture suite ${report.manifest}`];
  if (report.status === "error") {
    for (const error of report.errors) lines.push(`! ${error}`);
    return lines.join("\n");
  }
  for (const fixture of report.fixtures) {
    const sets = `expected [${fixture.expected.join(", ")}], actual [${fixture.actual.join(", ")}]`;
    if (fixture.passed) lines.push(`✓ ${fixture.id}: ${sets}`);
    else {
      const details = [
        sets,
        ...(fixture.missing.length ? [`missed: ${fixture.missing.join(", ")}`] : []),
        ...(fixture.unexpected.length ? [`unexpected: ${fixture.unexpected.join(", ")}`] : []),
      ];
      lines.push(`✗ ${fixture.id}: ${details.join("; ")}`);
    }
  }
  const passed = report.fixtures.filter((fixture) => fixture.passed).length;
  lines.push(`\n${passed}/${report.fixtures.length} fixtures passed, ${report.rules.length} rules`);
  return lines.join("\n");
}
