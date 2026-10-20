import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SuiteInputError, suiteErrorMessage, type RuleEvaluation } from "./evaluation-context.js";
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
  findings: { check_id: string; evidence_span_ids: string[] }[];
  rule_evaluations: RuleEvaluation[];
}

export interface FixtureSuiteReport {
  manifest: string;
  status: "passed" | "failed" | "error";
  exit_code: 0 | 1 | 2;
  rules: string[];
  fixtures: FixtureCaseResult[];
  errors: string[];
}

function parseManifest(file: string): z.infer<typeof Manifest> {
  const extension = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, "utf8");
  let value: unknown;
  if (extension === ".json") {
    try { value = JSON.parse(text); } catch { throw new SuiteInputError("invalid JSON manifest"); }
  }
  else if (extension === ".yaml" || extension === ".yml") {
    const document = YAML.parseDocument(text);
    if (document.errors.length) throw new SuiteInputError("invalid YAML manifest");
    value = document.toJS();
  } else throw new SuiteInputError("manifest must use .json, .yaml or .yml");

  const parsed = Manifest.safeParse(value);
  if (!parsed.success) throw new SuiteInputError("invalid manifest schema");
  const fixtureIds = parsed.data.fixtures.map((fixture) => fixture.id);
  const ruleIds = parsed.data.rules;
  if (new Set(fixtureIds).size !== fixtureIds.length) throw new SuiteInputError("fixture ids must be unique");
  if (new Set(ruleIds).size !== ruleIds.length) throw new SuiteInputError("rules must not contain duplicate ids");
  for (const fixture of parsed.data.fixtures) {
    if (new Set(fixture.expected).size !== fixture.expected.length) throw new SuiteInputError(`fixture ${fixture.id}: expected must not contain duplicate ids`);
    const outsideScope = fixture.expected.filter((ruleId) => !ruleIds.includes(ruleId));
    if (outsideScope.length) throw new SuiteInputError(`fixture ${fixture.id}: expected rule id(s) outside rules scope: ${outsideScope.join(", ")}`);
  }
  return parsed.data;
}

function ensureInputs(manifestPath: string, manifest: z.infer<typeof Manifest>): { checkDir: string; fixturePaths: Map<string, string> } {
  const base = path.dirname(manifestPath);
  const checkDir = path.resolve(base, manifest.checks);
  if (!fs.statSync(checkDir).isDirectory()) throw new SuiteInputError(`checks path is not a directory: ${manifest.checks}`);
  if (!fs.readdirSync(checkDir).some((entry) => /\.ya?ml$/i.test(entry) && fs.statSync(path.join(checkDir, entry)).isFile())) {
    throw new SuiteInputError(`checks directory has no YAML check files: ${manifest.checks}`);
  }
  const fixturePaths = new Map<string, string>();
  for (const fixture of manifest.fixtures) {
    const tracePath = path.resolve(base, fixture.trace);
    fixturePaths.set(fixture.id, tracePath);
  }
  return { checkDir, fixturePaths };
}

function validateRules(checkDir: string, ruleIds: string[]): RuleCheck[] {
  const loaded = new Map<string, ReturnType<typeof parseChecks>["checks"][number]>();
  for (const file of fs.readdirSync(checkDir).filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
    const filePath = path.join(checkDir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    let parsed: ReturnType<typeof parseChecks>;
    try { parsed = parseChecks(fs.readFileSync(filePath, "utf8")); }
    catch { throw new SuiteInputError(`invalid checks file: ${file}`); }
    if (parsed.errors.length) throw new SuiteInputError(`invalid checks file: ${file}`);
    for (const check of parsed.checks) {
      if (loaded.has(check.id)) throw new SuiteInputError(`duplicate custom check id: ${check.id}`);
      loaded.set(check.id, check);
    }
  }
  return ruleIds.map((ruleId) => {
    const check = loaded.get(ruleId);
    if (!check) throw new SuiteInputError(`unknown rule id in rules: ${ruleId}`);
    if (!isRule(check)) throw new SuiteInputError(`question check id is not a rule: ${ruleId}`);
    if (check.enabled === false) throw new SuiteInputError(`disabled rule cannot be tested: ${ruleId}`);
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
    const errors: string[] = [];
    for (const fixture of manifest.fixtures) {
      const tracePath = fixturePaths.get(fixture.id)!;
      try {
        if (!fs.statSync(tracePath, { throwIfNoEntry: false })?.isFile()) throw new SuiteInputError(`trace path is not a file: ${fixture.trace}`);
        const result = checkFiles([tracePath], {
          explicitRules: rules,
          fixture: { traceId: fixture.trace_id },
        });
        if (result.errors.length) throw new SuiteInputError("offline evaluation reported errors");
        const selected = result.runs[0];
        const evaluations = selected.rule_evaluations ?? [];
        const complete = evaluations.length === rules.length && evaluations.every((entry) => entry.status === "evaluated");
        for (const entry of evaluations) {
          if (entry.status !== "evaluated") errors.push(`fixture ${fixture.id}: ${entry.check_id}: ${entry.status} (${entry.reason})`);
        }
        if (evaluations.length !== rules.length) errors.push(`fixture ${fixture.id}: incomplete rule diagnostics`);
        const findings = selected.findings.map((finding) => ({
          check_id: finding.check_id,
          evidence_span_ids: [...new Set(finding.evidence_span_ids)].sort(),
        })).sort((a, b) => a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0);
        const expected = [...fixture.expected].sort();
        const actual = [...new Set(selected.findings.map((finding) => finding.check_id))].sort();
        const expectedSet = new Set(expected);
        const actualSet = new Set(actual);
        const missing = expected.filter((ruleId) => !actualSet.has(ruleId));
        const unexpected = actual.filter((ruleId) => !expectedSet.has(ruleId));
        fixtures.push({
          id: fixture.id,
          trace: fixture.trace,
          trace_id: selected.trace_id,
          expected,
          actual,
          missing,
          unexpected,
          passed: complete && missing.length === 0 && unexpected.length === 0,
          findings,
          rule_evaluations: [...evaluations].sort((a, b) => a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0),
        });
      } catch (error) {
        errors.push(`fixture ${fixture.id}: ${suiteErrorMessage(error)}`);
      }
    }
    const passed = fixtures.every((fixture) => fixture.passed);
    return {
      manifest: manifestFile,
      status: errors.length ? "error" : passed ? "passed" : "failed",
      exit_code: errors.length ? 2 : passed ? 0 : 1,
      rules: manifest.rules,
      fixtures,
      errors,
    };
  } catch (error) {
    return errorReport(manifestFile, suiteErrorMessage(error));
  }
}

export function formatFixtureReport(report: FixtureSuiteReport): string {
  const lines = [`Checks fixture suite ${report.manifest}`];
  for (const error of report.errors) lines.push(`! ${error}`);
  for (const fixture of report.fixtures) {
    for (const finding of fixture.findings) lines.push(`  ${fixture.id}: ${finding.check_id} evidence [${finding.evidence_span_ids.join(", ")}]`);
    for (const entry of fixture.rule_evaluations) lines.push(`  ${fixture.id}: ${entry.check_id} ${entry.status} (${entry.reason})`);
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
