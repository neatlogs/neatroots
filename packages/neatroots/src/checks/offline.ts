import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootsHome } from "../config.js";
import { loadTrace } from "../engine/trace.js";
import { parseTraceFile } from "../ingest/importers/file.js";
import { Store } from "../store/db.js";
import { CheckRegistry } from "./registry.js";
import { evaluateRule } from "./rules.js";
import { isRule, type RuleCheck } from "./types.js";

export interface OfflineFinding {
  check_id: string;
  title: string;
  evidence_span_ids: string[];
  params: Record<string, string>;
}

export interface OfflineRun {
  file: string;
  trace_id: string;
  root_name: string | null;
  workflow?: string | null;
  duration_ms?: number | null;
  findings: OfflineFinding[];
}

export interface CheckResult {
  runs: OfflineRun[];
  rules: string[];
  errors: string[];
}

export interface OfflineOptions {
  /** Extra checks folders, loaded after the library and ~/.neatroots/checks. */
  dirs?: string[];
  /** Only these rule ids. */
  only?: string[];
}

/** Runs every rule check over saved traces, with no server and no model. Question checks are skipped. */
export function checkFiles(files: string[], opts: OfflineOptions = {}): CheckResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-check-"));
  const store = new Store(dir);
  try {
    if (opts.only && !opts.only.length) throw new Error("--only names no rule ids");
    const registry = new CheckRegistry(store, path.join(rootsHome(), "checks"), () => opts.dirs ?? []);
    const errors = registry.errors.map((e) => `${e.path}: ${e.message.split("\n")[0]}`);
    const loaded = registry.rules().filter((lc) => isRule(lc.check) && (!opts.only || opts.only.includes(lc.check.id)));
    const rules = loaded.map((lc) => lc.check as RuleCheck);
    const untrusted = new Set(loaded.filter((lc) => lc.source !== "library").map((lc) => lc.check.id));
    const unknown = (opts.only ?? []).filter((id) => !rules.some((r) => r.id === id));
    if (unknown.length) throw new Error(`no rule check named ${unknown.join(", ")}`);
    const runs: OfflineRun[] = [];
    for (const file of files) {
      const traceIds = store.ingest(parseTraceFile(fs.readFileSync(file, "utf8"), path.basename(file))).map((u) => u.traceId);
      for (const traceId of [...new Set(traceIds)]) {
        const run = store.getRun(traceId);
        const snap = loadTrace(store, traceId);
        const findings: OfflineFinding[] = [];
        for (const rule of rules) {
          const a = rule.applies_to;
          const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
          if (run && ((list(a?.project) && !list(a?.project)!.includes(run.project ?? "")) || (list(a?.workflow) && !list(a?.workflow)!.includes(run.workflow ?? "")))) continue;
          const hit = evaluateRule(rule, snap, true, undefined, untrusted.has(rule.id));
          if (hit) findings.push({ check_id: rule.id, title: rule.title ?? rule.id, evidence_span_ids: hit.evidenceSpanIds, params: hit.params });
        }
        const end = run?.ended_ms ?? run?.last_span_ms;
        const duration_ms = run?.started_ms && end ? Math.max(0, end - run.started_ms) : 0;
        runs.push({
          file,
          trace_id: traceId,
          root_name: run?.root_name ?? null,
          workflow: run?.workflow ?? null,
          duration_ms,
          findings,
        });
        // Each file gets its own verdict: a later file with the same trace id must not see these spans.
        store.deleteRun(traceId);
      }
    }
    return { runs, rules: rules.map((r) => r.id), errors };
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Escapes XML control characters and standard entities (&, <, >, ", '). */
export function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Formats offline check results into standard JUnit XML. */
export function formatJUnit(result: CheckResult): string {
  const { runs, errors = [] } = result;
  const failed = runs.filter((r) => r.findings.length > 0);
  const tests = runs.length + errors.length;
  const failures = failed.length;
  const errorCount = errors.length;
  const totalTime = (runs.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0) / 1000).toFixed(3);

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<testsuites>`);
  lines.push(
    `  <testsuite name="neatroots check" tests="${tests}" failures="${failures}" errors="${errorCount}" time="${totalTime}">`,
  );

  for (const run of runs) {
    const classname = run.workflow ? `${run.file}/${run.workflow}` : run.file;
    const name = `${run.trace_id}${run.root_name ? ` ${run.root_name}` : ""}`;
    const time = ((run.duration_ms ?? 0) / 1000).toFixed(3);

    if (!run.findings.length) {
      lines.push(`    <testcase classname="${escapeXml(classname)}" name="${escapeXml(name)}" time="${time}"/>`);
    } else {
      lines.push(`    <testcase classname="${escapeXml(classname)}" name="${escapeXml(name)}" time="${time}">`);
      for (const f of run.findings) {
        const details = [
          `check_id: ${f.check_id}`,
          `title: ${f.title}`,
          `evidence_span_ids: ${f.evidence_span_ids.join(", ") || "none"}`,
          ...(Object.keys(f.params ?? {}).length ? [`params: ${JSON.stringify(f.params)}`] : []),
        ].join("\n");
        lines.push(
          `      <failure message="[${escapeXml(f.check_id)}] ${escapeXml(f.title)}">${escapeXml(details)}</failure>`,
        );
      }
      lines.push(`    </testcase>`);
    }
  }

  for (const err of errors) {
    const parts = err.split(": ");
    const target = parts[0] ?? "config";
    const msg = parts.slice(1).join(": ") || err;
    lines.push(`    <testcase classname="config" name="${escapeXml(target)}" time="0.000">`);
    lines.push(`      <error message="${escapeXml(msg)}">${escapeXml(err)}</error>`);
    lines.push(`    </testcase>`);
  }

  lines.push(`  </testsuite>`);
  lines.push(`</testsuites>`);
  return lines.join("\n");
}

/** Formats an unhandled or command-level error into JUnit XML. */
export function formatJUnitError(err: Error): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<testsuites>`);
  lines.push(`  <testsuite name="neatroots check" tests="1" failures="0" errors="1" time="0.000">`);
  lines.push(`    <testcase classname="check" name="error" time="0.000">`);
  lines.push(`      <error message="${escapeXml(err.message)}">${escapeXml(err.stack ?? err.message)}</error>`);
  lines.push(`    </testcase>`);
  lines.push(`  </testsuite>`);
  lines.push(`</testsuites>`);
  return lines.join("\n");
}
