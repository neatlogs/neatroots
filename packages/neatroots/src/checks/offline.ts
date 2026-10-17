import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { rootsHome } from "../config.js";
import { loadTrace } from "../engine/trace.js";
import { parseTraceFile } from "../ingest/importers/file.js";
import { Store } from "../store/db.js";
import { CheckRegistry } from "./registry.js";
import { evaluateRule } from "./rules.js";
import { isRule, type Check, type RuleCheck } from "./types.js";

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
  /** Extra checks folders; in reproducible mode these are the complete check set. */
  dirs?: string[];
  /** Only these rule ids. */
  only?: string[];
  /** Load only the explicit, repository-local directories and record a reproducible selection. */
  reproducible?: boolean;
}

export interface OfflineCheckManifest {
  version: 1;
  directories: string[];
  checks: { id: string; kind: Check["kind"]; source: string; sha256: string }[];
  rules: string[];
}

export type CheckManifestStatus = "created" | "matched";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function repositoryPath(value: string, label: string): { absolute: string; relative: string } {
  const root = path.resolve(process.cwd());
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the current working directory (${root})`);
  }
  // Resolve the nearest existing ancestor too: a lexical child may be a symlink
  // (or Windows junction) to machine-local files outside the working directory.
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`${label} must be inside the current working directory (${root})`);
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

function checkManifest(registry: CheckRegistry, directories: string[], rules: RuleCheck[]): OfflineCheckManifest {
  const checks = registry.all()
    .map((loaded) => {
      if (!loaded.path) throw new Error(`repository check ${loaded.check.id} has no source file`);
      const check: Check = { ...loaded.check, enabled: loaded.check.enabled ?? true };
      const sha256 = createHash("sha256").update(stableJson(check)).digest("hex");
      return {
        id: check.id,
        kind: check.kind,
        source: repositoryPath(loaded.path, "check source").relative,
        sha256,
      };
    })
    .sort((a, b) => compareText(a.id, b.id));
  return { version: 1, directories, checks, rules: rules.map((rule) => rule.id) };
}

/** Create a lock the first time; later runs must resolve to the exact same check set and selection. */
export function recordOrVerifyCheckManifest(file: string, manifest: OfflineCheckManifest): CheckManifestStatus {
  const { absolute, relative } = repositoryPath(file, "check lockfile");
  const readAndVerify = (): void => {
    let saved: unknown;
    try {
      saved = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch {
      throw new Error(`could not read check lockfile ${relative} as JSON`);
    }
    if (stableJson(saved) !== stableJson(manifest)) {
      throw new Error(`repository check configuration differs from ${relative}; remove the lockfile to accept intentional changes`);
    }
  };

  if (fs.existsSync(absolute)) {
    readAndVerify();
    return "matched";
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  try {
    fs.writeFileSync(absolute, `${JSON.stringify(canonical(manifest), null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    readAndVerify();
    return "matched";
  }
  return "created";
}

/** Runs every rule check over saved traces, with no server and no model. Question checks are skipped. */
export function checkFiles(files: string[], opts: OfflineOptions = {}): {
  runs: OfflineRun[];
  rules: string[];
  errors: string[];
  manifest?: OfflineCheckManifest;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-check-"));
  const store = new Store(dir);
  try {
    if (opts.only && !opts.only.length) throw new Error("--only names no rule ids");
    let checkDirs = opts.dirs ?? [];
    let manifestDirs: string[] = [];
    if (opts.reproducible) {
      if (!checkDirs.length) throw new Error("--reproducible requires at least one --checks directory");
      const resolved = checkDirs.map((value) => {
        const dirInfo = repositoryPath(value, "--checks directory");
        if (!fs.existsSync(dirInfo.absolute) || !fs.statSync(dirInfo.absolute).isDirectory()) {
          throw new Error(`--checks directory does not exist: ${dirInfo.relative}`);
        }
        return dirInfo;
      });
      checkDirs = resolved.map((entry) => entry.absolute);
      manifestDirs = resolved.map((entry) => entry.relative);
    }
    const registry = new CheckRegistry(
      store,
      opts.reproducible ? "" : path.join(rootsHome(), "checks"),
      () => checkDirs,
      opts.reproducible ? { library: false, user: false, database: false } : undefined,
    );
    const errors = registry.errors.map((e) => `${e.path}: ${e.message.split("\n")[0]}`);
    const loaded = registry.rules().filter((lc) => isRule(lc.check) && (!opts.only || opts.only.includes(lc.check.id)));
    if (opts.reproducible) loaded.sort((a, b) => compareText(a.check.id, b.check.id));
    const rules = loaded.map((lc) => lc.check as RuleCheck);
    const untrusted = new Set(loaded.filter((lc) => lc.source !== "library").map((lc) => lc.check.id));
    const unknown = (opts.only ?? []).filter((id) => !rules.some((r) => r.id === id));
    if (unknown.length) throw new Error(`no rule check named ${unknown.join(", ")}`);
    if (opts.reproducible && !rules.length) throw new Error("no enabled repository rule checks selected");
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
        // Each file gets its own verdict, even when input files repeat a trace id.
        store.deleteRun(traceId);
      }
    }
    return {
      runs,
      rules: rules.map((r) => r.id),
      errors,
      ...(opts.reproducible ? { manifest: checkManifest(registry, manifestDirs, rules) } : {}),
    };
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
