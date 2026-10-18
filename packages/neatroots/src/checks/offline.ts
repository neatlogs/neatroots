import { beginEvaluation, createEvaluationContext, SuiteInputError, type RuleEvaluation } from "./evaluation-context.js";
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
  findings: OfflineFinding[];
  rule_evaluations?: RuleEvaluation[];
}

export interface OfflineOptions {
  /** Extra checks folders, loaded after the library and ~/.neatroots/checks. */
  dirs?: string[];
  /** Only these rule ids. */
  only?: string[];
  /** Evaluate only these parsed rules, without reading library, personal, project or database checks. */
  explicitRules?: readonly RuleCheck[];
  /** Opt-in strict fixture evaluation; select before evaluating any imported trace. */
  fixture?: { traceId?: string };
}

/** Runs every rule check over saved traces, with no server and no model. Question checks are skipped. */
export function checkFiles(files: string[], opts: OfflineOptions = {}): { runs: OfflineRun[]; rules: string[]; errors: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-check-"));
  const store = new Store(dir);
  try {
    if (opts.fixture && !opts.explicitRules) throw new Error("fixture evaluation requires explicit rules");
    if (opts.only && !opts.only.length) throw new Error("--only names no rule ids");
    const registry = opts.explicitRules === undefined
      ? new CheckRegistry(store, path.join(rootsHome(), "checks"), () => opts.dirs ?? [])
      : undefined;
    const errors = registry?.errors.map((e) => `${e.path}: ${e.message.split("\n")[0]}`) ?? [];
    const loaded = registry?.rules() ?? [];
    const rules = (opts.explicitRules ?? loaded.map((lc) => lc.check))
      .filter((c) => c.enabled !== false)
      .filter((c): c is RuleCheck => isRule(c) && (!opts.only || opts.only.includes(c.id)));
    const untrusted = new Set(opts.explicitRules !== undefined
      ? rules.map((rule) => rule.id)
      : loaded.filter((lc) => lc.source !== "library").map((lc) => lc.check.id));
    const unknown = (opts.only ?? []).filter((id) => !rules.some((r) => r.id === id));
    if (unknown.length) throw new Error(`no rule check named ${unknown.join(", ")}`);
    const runs: OfflineRun[] = [];
    for (const file of files) {
      let batches: ReturnType<typeof parseTraceFile>;
      try {
        batches = parseTraceFile(fs.readFileSync(file, "utf8"), path.basename(file));
      } catch (error) {
        if (!opts.fixture) throw error;
        // Parser errors can quote raw trace text. Suite reports expose identifiers only.
        throw new SuiteInputError("trace file could not be parsed");
      }
      const traceIds = store.ingest(batches).map((u) => u.traceId);
      let selected = [...new Set(traceIds)];
      if (opts.fixture) {
        if (!selected.length) throw new SuiteInputError("trace file imported no runs");
        if (opts.fixture.traceId !== undefined) {
          selected = selected.filter((id) => id === opts.fixture!.traceId);
          if (!selected.length) throw new SuiteInputError(`trace_id ${opts.fixture.traceId} was not found`);
        }
        if (selected.length !== 1) throw new SuiteInputError(`${selected.length} traces imported; set trace_id to select exactly one`);
      }
      for (const traceId of selected) {
        const run = store.getRun(traceId);
        const snap = loadTrace(store, traceId);
        const findings: OfflineFinding[] = [];
        const context = opts.fixture ? createEvaluationContext() : undefined;
        const evaluations: RuleEvaluation[] = [];
        for (const rule of rules) {
          if (context) beginEvaluation(context, rule.id);
          const a = rule.applies_to;
          const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
          if (run && ((list(a?.project) && !list(a?.project)!.includes(run.project ?? "")) || (list(a?.workflow) && !list(a?.workflow)!.includes(run.workflow ?? "")))) {
            if (context) evaluations.push({ check_id: rule.id, status: "unevaluated", reason: "scope_mismatch" });
            continue;
          }
          let hit: ReturnType<typeof evaluateRule> = null;
          try {
            hit = evaluateRule(rule, snap, true, undefined, untrusted.has(rule.id), context);
          } catch (error) {
            if (!context) throw error;
            context.outcome = { check_id: rule.id, status: "error", reason: "evaluation_error" };
          }
          if (context) evaluations.push({ ...context.outcome });
          if (hit && (!opts.fixture || hit.firing)) findings.push({ check_id: rule.id, title: rule.title ?? rule.id, evidence_span_ids: hit.evidenceSpanIds, params: hit.params });
        }
        runs.push({ file, trace_id: traceId, root_name: run?.root_name ?? null, findings, ...(context ? { rule_evaluations: evaluations } : {}) });
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
