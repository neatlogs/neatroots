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
}

export interface OfflineOptions {
  /** Extra checks folders, loaded after the library and ~/.neatroots/checks. */
  dirs?: string[];
  /** Only these rule ids. */
  only?: string[];
}

/** Runs every rule check over saved traces, with no server and no model. Question checks are skipped. */
export function checkFiles(files: string[], opts: OfflineOptions = {}): { runs: OfflineRun[]; rules: string[]; errors: string[] } {
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
        runs.push({ file, trace_id: traceId, root_name: run?.root_name ?? null, findings });
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
