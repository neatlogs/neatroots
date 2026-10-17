import fs from "node:fs";
import { newId, sha256 } from "../util/ids.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { AnyCheck, isQuestion, isRule, type Check, type CheckSource, type LoadedCheck } from "./types.js";
import type { McpCheckProposalRow, Store } from "../store/db.js";
import { log } from "../util/log.js";
import { assertNoHaltFromAgent } from "./agent-policy.js";
import { McpManualApplicationError } from "./mcp-approval-policy.js";

function findLibraryDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "library");
    if (fs.existsSync(path.join(candidate, "rules.yaml"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("neatroots could not find its check library");
}

export interface CheckLoadError {
  path: string;
  id?: string;
  message: string;
}

/** Whether anything sits at this path, a link that points nowhere included (existsSync follows links). */
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The nearest path above `dir` that something occupies without being a directory, if one stands
 * between it and creation. A link that points nowhere counts: nothing can be created through it.
 */
function ancestorInTheWay(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return undefined; // the root itself, which is always there
    if (entryExists(parent)) {
      try {
        if (fs.statSync(parent).isDirectory()) return undefined;
      } catch {
        // A link whose target is gone: it is in the way all the same.
      }
      return parent;
    }
    cur = parent;
  }
}

/**
 * How a checks directory reads on disk. `missing` separates the normal case (a project with no
 * checks yet) from a path that is there but unusable, such as a file where a directory belongs.
 * `creatable` is the separate save-time question: the path isn't there and nothing but directories
 * stands above it, so `CheckRegistry.save()` can make it. `reason` reads after the path, the way
 * the Checks page prints a load error.
 */
export function checkDirState(dir: string): { ok: true } | { ok: false; missing: boolean; creatable: boolean; reason: string } {
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, missing: false, creatable: false, reason: "is a file, not a directory" };
    fs.readdirSync(dir);
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const detail = code ?? (e as Error).message;
    // There but unreadable (a file, a link that points nowhere, a folder without permission): nothing
    // to create, so a save can't rescue it.
    if (entryExists(dir)) return { ok: false, missing: false, creatable: false, reason: `can't be read as a directory (${detail})` };
    // Not there. A save can make it unless a file stands in the way: Windows answers ENOENT where
    // other platforms answer ENOTDIR for exactly that shape, so ask the ancestors, not the code.
    const blocking = ancestorInTheWay(dir);
    return blocking
      ? { ok: false, missing: false, creatable: false, reason: `sits under ${blocking}, which is a file, not a directory` }
      : { ok: false, missing: true, creatable: true, reason: "does not exist" };
  }
}

export interface PendingMcpCheck {
  check: Check;
  revision: string;
  created_ms: number;
  target_dir: string | null;
  has_active_version: boolean;
  target_path: string;
  manual_application_required: boolean;
}

type CheckDestinationSnapshot =
  | { kind: "missing" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "other" }
  | { kind: "unreadable"; code: string };

/** Parses YAML holding one check, a list of checks, or `{checks: [...]}`. */
export function parseChecks(text: string): { checks: Check[]; errors: { id?: string; message: string }[] } {
  const checks: Check[] = [];
  const errors: { id?: string; message: string }[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) {
      errors.push({ message: doc.errors.map((e) => e.message).join("; ") });
      continue;
    }
    let value: unknown;
    try {
      value = doc.toJS();
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (value === null || value === undefined) continue;
    const items = Array.isArray(value)
      ? value
      : typeof value === "object" && Array.isArray((value as { checks?: unknown }).checks)
        ? (value as { checks: unknown[] }).checks
        : [value];
    for (const item of items) {
      const parsed = AnyCheck.safeParse(item);
      if (parsed.success) checks.push(parsed.data as Check);
      else {
        const id = (item as { id?: string })?.id;
        errors.push({ id, message: parsed.error.issues.map((i) => `${i.path.join(".") || "check"}: ${i.message}`).join("; ") });
      }
    }
  }
  return { checks, errors };
}

/**
 * Rewrites every check with this id in a checks file and leaves all other text as written:
 * comments, other checks (including ones that don't validate yet) and other documents.
 * Returns undefined when the file has no check with this id.
 */
function replaceInYaml(text: string, check: Check): string | undefined {
  const isOurs = (n: unknown): n is YAML.YAMLMap => YAML.isMap(n) && n.get("id") === check.id;
  const spans: { start: number; end: number; node: YAML.YAMLMap }[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) continue;
    const contents = doc.contents;
    const wrapped = YAML.isMap(contents) ? contents.get("checks", true) : undefined;
    const list = YAML.isSeq(contents) ? contents : YAML.isSeq(wrapped) ? wrapped : undefined;
    for (const node of isOurs(contents) ? [contents] : (list?.items ?? [])) {
      if (isOurs(node) && node.range) spans.push({ start: node.range[0], end: node.range[1], node });
    }
  }
  if (!spans.length) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text;
  for (const { start, end, node } of spans.reverse()) {
    let next: string;
    if (node.flow) next = YAML.stringify(check, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
    else {
      // A block mapping's text runs to the end of its last line; continue at its column.
      const pad = " ".repeat(start - (text.lastIndexOf("\n", start - 1) + 1));
      next = checkToYaml(check).trimEnd().split("\n").join(`${eol}${pad}`) + eol;
    }
    out = out.slice(0, start) + next + out.slice(end);
  }
  return out;
}

export function checkToYaml(check: Check): string {
  return YAML.stringify(check, { lineWidth: 100 });
}

/**
 * All checks in force: the shipped library, then ~/.neatroots/checks, then each project's
 * .neatroots/checks, then planner checks and MCP checks approved in the Checks page. A later source replaces
 * an earlier check with the same id.
 */
export class CheckRegistry {
  private checks = new Map<string, LoadedCheck>();
  errors: CheckLoadError[] = [];
  readonly libraryDir = findLibraryDir();

  constructor(
    private readonly store: Store,
    private readonly userDir: string,
    private readonly projectDirs: () => string[],
  ) {
    this.reload();
  }

  reload(): void {
    const next = new Map<string, LoadedCheck>();
    const errors: CheckLoadError[] = [];
    const loadDir = (dir: string, source: CheckSource) => {
      const state = checkDirState(dir);
      // A directory that isn't there is the normal case (a project without checks yet). Anything
      // else is reported on the Checks page instead of throwing out of the constructor: a config
      // holding a path that turned into a file used to stop `neatroots start` before it listened.
      if (!state.ok) {
        if (!state.missing) errors.push({ path: dir, message: state.reason });
        return;
      }
      for (const f of fs.readdirSync(dir).sort()) {
        if (!/\.ya?ml$/i.test(f)) continue;
        const p = path.join(dir, f);
        // One bad entry is one bad check file, not a reason to abandon the whole load. A name that
        // matches the filter but isn't a readable file (a directory called draft.yaml, a broken
        // symlink, a file the user can't read) used to throw EISDIR or EACCES out of the
        // constructor here, which took `neatroots start` down before it listened (#224).
        let text: string;
        try {
          text = fs.readFileSync(p, "utf8");
        } catch (e) {
          errors.push({ path: p, message: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
          continue;
        }
        const { checks, errors: errs } = parseChecks(text);
        for (const e of errs) errors.push({ path: p, ...e });
        for (const c of checks) {
          const origin = this.store.getMeta(`mcp_origin:${c.id}`);
          // Provenance follows the ID across moves and shadows; only a human save clears it.
          const authoredByMcp = source !== "library" && origin !== undefined;
          next.set(c.id, { check: c, source: authoredByMcp ? "mcp" : source, path: p });
        }
      }
    };
    loadDir(this.libraryDir, "library");
    loadDir(this.userDir, "user");
    for (const d of this.projectDirs()) loadDir(d, "project");
    const rows = this.store.db
      .prepare("SELECT id, source, path, body FROM checks WHERE source IN ('planner', 'mcp')")
      .all() as { id: string; source: CheckSource; path: string | null; body: string }[];
    for (const r of rows) {
      const loaded = next.get(r.id);
      if (r.source === "mcp" && r.path) {
        // Approved MCP checks stay file-backed, while this row preserves their origin. The file
        // remains the source of truth; a missing or unregistered file must not revive a stale copy.
        if (loaded?.path && loaded.source !== "library") next.set(r.id, { ...loaded, source: "mcp" });
        continue;
      }
      if (loaded) continue;
      const { checks } = parseChecks(r.body);
      if (checks[0]) next.set(r.id, { check: checks[0], source: r.source, path: r.path });
    }
    for (const [id, lc] of next) {
      this.store.upsertCheckRow({ id, kind: lc.check.kind === "rule" ? "rule" : "question", source: lc.source, path: lc.path, body: checkToYaml(lc.check), enabled: lc.check.enabled });
    }
    this.checks = next;
    const seen = new Set(this.errors.map((e) => `${e.path}|${e.id}|${e.message}`));
    this.errors = errors;
    for (const e of errors) if (!seen.has(`${e.path}|${e.id}|${e.message}`)) log.warn(`check ${e.id ?? ""} in ${e.path}: ${e.message.split("\n")[0]}`);
  }

  get(id: string): LoadedCheck | undefined {
    return this.checks.get(id);
  }

  all(): LoadedCheck[] {
    return [...this.checks.values()];
  }

  enabled(): LoadedCheck[] {
    const stats = this.store.checkStats();
    return this.all().filter((c) => (c.source !== "mcp" || this.isApprovedMcp(c.check.id)) && c.check.enabled !== false && (stats[c.check.id]?.enabled ?? 1) === 1);
  }

  rules(): LoadedCheck[] {
    return this.enabled().filter((c) => isRule(c.check));
  }

  questions(): LoadedCheck[] {
    return this.enabled().filter((c) => isQuestion(c.check));
  }

  library(): LoadedCheck[] {
    return this.all().filter((c) => c.source === "library" && isQuestion(c.check));
  }

  private fromMcpProposal(row: McpCheckProposalRow): PendingMcpCheck | undefined {
    if (row.target_dir === "") return undefined; // Legacy blank targets must be resubmitted for review.
    const { checks } = parseChecks(row.body);
    const check = checks.find((c) => c.id === row.id);
    if (!check) return undefined;
    let destination = path.join(row.target_dir ?? this.userDir, `${row.id}.yaml`), manual = true;
    try { destination = this.approvalDestination(row.id, row.target_dir, check); manual = this.destinationSnapshot(destination).kind !== "missing"; } catch { /* unreadable targets require manual review */ }
    return { check, revision: row.revision, created_ms: row.created_ms, target_dir: row.target_dir, target_path: destination, manual_application_required: manual, has_active_version: this.enabled().some((c) => c.check.id === row.id) };
  }

  pendingMcp(): PendingMcpCheck[] {
    return this.store.listMcpCheckProposals().flatMap((row) => {
      const proposal = this.fromMcpProposal(row);
      return proposal ? [proposal] : [];
    });
  }

  pendingMcpCheck(id: string): PendingMcpCheck | undefined {
    const row = this.store.getMcpCheckProposal(id);
    return row ? this.fromMcpProposal(row) : undefined;
  }

  proposeMcp(check: Check, targetDir: string | null): PendingMcpCheck {
    if (targetDir === "") targetDir = null;
    const parsed = AnyCheck.parse(check) as Check;
    this.reload();
    const active = this.get(parsed.id);
    targetDir ??= active?.path && active.source !== "library" ? path.dirname(active.path) : this.userDir;
    assertNoHaltFromAgent(parsed, active?.check);
    if (active?.path && active.source !== "library" && targetDir && path.resolve(targetDir) !== path.resolve(path.dirname(active.path))) throw new Error("MCP edits must target the active check directory");
    this.store.upsertMcpCheckProposal(parsed.id, checkToYaml(parsed), targetDir, newId("proposal"), this.approvalFingerprint(parsed.id, targetDir, parsed));
    const proposal = this.pendingMcpCheck(parsed.id);
    if (!proposal) throw new Error(`could not save MCP check proposal ${parsed.id}`);
    return proposal;
  }
  private activeFingerprint(id: string): string {
    const active = this.get(id);
    return sha256(JSON.stringify(active ? [checkToYaml(active.check), active.path, active.source, this.store.checkStats()[id]?.enabled] : null));
  }

  private approvalDestination(id: string, targetDir: string | null, check: Check): string {
    const active = this.get(id);
    const dir = targetDir || this.userDir;
    const canUpdateActive =
      active?.path &&
      (active.source === "user" || active.source === "project" || active.source === "mcp") &&
      (!targetDir || path.resolve(path.dirname(active.path)) === path.resolve(dir)) &&
      fs.existsSync(active.path);
    if (canUpdateActive && active?.path) {
      const existing = fs.readFileSync(active.path, "utf8");
      if (replaceInYaml(existing, check) !== undefined) return active.path;
    }
    return path.join(dir, `${id}.yaml`);
  }

  private destinationSnapshot(file: string): CheckDestinationSnapshot {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() ? { kind: "file", bytes: fs.readFileSync(file) } : { kind: "other" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code: code ?? "unknown" };
    }
  }

  private destinationFingerprint(file: string, snapshot: CheckDestinationSnapshot): string {
    const state = snapshot.kind === "file" ? [snapshot.kind, sha256(snapshot.bytes)] : snapshot.kind === "unreadable" ? [snapshot.kind, snapshot.code] : [snapshot.kind];
    return sha256(JSON.stringify([path.resolve(file), state]));
  }

  private approvalFingerprint(id: string, targetDir: string | null, check: Check): string {
    const destination = this.approvalDestination(id, targetDir, check);
    const snapshot = this.destinationSnapshot(destination);
    return JSON.stringify({ active: this.activeFingerprint(id), destination: this.destinationFingerprint(destination, snapshot) });
  }

  private saveApprovedMcp(check: Check, destination: string, snapshot: CheckDestinationSnapshot): LoadedCheck {
    const parsed = AnyCheck.parse(check) as Check;
    assertNoHaltFromAgent(parsed, this.get(parsed.id)?.check);
    if (snapshot.kind !== "missing") throw new McpManualApplicationError(destination);
    const text = checkToYaml(parsed);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const originKey = `mcp_origin:${parsed.id}`;
    const previousOrigin = this.store.getMeta(originKey);
    this.store.setMeta(originKey, JSON.stringify([checkToYaml(parsed), path.resolve(destination)]));
    try {
      fs.writeFileSync(destination, text, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      const exclusiveConflict = snapshot.kind === "missing" && (error as NodeJS.ErrnoException).code === "EEXIST";
      // Restore only proven no-writes; changed or unreadable content retains MCP provenance.
      if (exclusiveConflict || this.destinationFingerprint(destination, this.destinationSnapshot(destination)) === this.destinationFingerprint(destination, snapshot)) {
        if (previousOrigin === undefined) this.store.db.prepare("DELETE FROM meta WHERE key = ?").run(originKey);
        else this.store.setMeta(originKey, previousOrigin);
      }
      if (exclusiveConflict) throw new Error("approval target changed; destination was created during approval");
      throw error;
    }
    this.store.upsertCheckRow({ id: parsed.id, kind: parsed.kind === "rule" ? "rule" : "question", source: "mcp", path: destination, body: checkToYaml(parsed), enabled: parsed.enabled });
    this.reload();
    return this.checks.get(parsed.id) ?? { check: parsed, source: "mcp", path: destination };
  }

  isApprovedMcp(id: string): boolean {
    const active = this.get(id);
    return !!active?.path && this.store.getMeta(`approved_mcp:${id}`) === sha256(JSON.stringify([checkToYaml(active.check), path.resolve(active.path)]));
  }

  approvePendingMcp(id: string, revision: string): LoadedCheck | undefined {
    const proposal = this.pendingMcpCheck(id);
    if (!proposal) return undefined;
    if (!revision || proposal.revision !== revision) throw new Error("proposal changed; refresh and review it again");
    this.reload();
    const row = this.store.getMcpCheckProposal(id)!;
    const dir = proposal.target_dir;
    const destination = this.approvalDestination(id, dir, proposal.check);
    const snapshot = this.destinationSnapshot(destination);
    let expected: { active?: string; destination?: string } | undefined;
    try { expected = JSON.parse(row.active_fingerprint) as { active?: string; destination?: string }; } catch { /* proposals from the previous fingerprint format must be reviewed again */ }
    if (expected?.active !== this.activeFingerprint(id)) throw new Error("active check changed; ask the agent to submit a new proposal");
    if (expected.destination !== this.destinationFingerprint(destination, snapshot)) throw new Error("approval target changed; review the destination and submit a new proposal");
    if (dir && path.resolve(dir) !== path.resolve(this.userDir) && !this.projectDirs().some((p) => path.resolve(p) === path.resolve(dir))) throw new Error("approval target changed; submit a new proposal for a registered directory");
    const state = checkDirState(dir || this.userDir);
    if (!state.ok && !state.creatable) throw new Error(`approval target changed; that directory ${state.reason}`);
    const beforeWrite = this.destinationSnapshot(destination);
    if (expected.destination !== this.destinationFingerprint(destination, beforeWrite)) throw new Error("approval target changed; review the destination and submit a new proposal");
    const approved = this.saveApprovedMcp(proposal.check, destination, beforeWrite);
    if (!approved.path || checkToYaml(approved.check) !== checkToYaml(proposal.check)) throw new Error("approval target changed; another file shadows the proposed definition");
    if (path.resolve(approved.path) !== path.resolve(destination)) throw new Error("approval target changed; another file shadows the proposed destination");
    this.store.db.transaction(() => {
      this.store.setMeta(`approved_mcp:${id}`, sha256(JSON.stringify([checkToYaml(approved.check), path.resolve(approved.path!)])));
      this.store.deleteMcpCheckProposal(id);
    })();
    this.reload();
    return this.get(id) ?? approved;
  }

  rejectPendingMcp(id: string, revision: string): boolean {
    const pending = this.pendingMcpCheck(id);
    if (!pending) return false;
    if (!revision || pending.revision !== revision) throw new Error("proposal changed; refresh and review it again");
    return this.store.deleteMcpCheckProposal(id);
  }

  /**
   * Saves a check. `target` is "user" (~/.neatroots/checks), a project checks directory, or
   * "db" for planner-written checks that live only in the database until a person keeps them.
   * A check that already lives in a user or project file is updated in that file, unless
   * `target` names a different directory.
   */
  save(check: Check, target: "user" | "db" | { dir: string }, source: CheckSource = "user", expectedPath?: string): LoadedCheck {
    const parsed = AnyCheck.parse(check) as Check;
    if (expectedPath) this.reload();
    if (source === "mcp") assertNoHaltFromAgent(parsed, this.checks.get(parsed.id)?.check);
    let p: string | null = null;
    const recordOrigin = (file: string) => {
      if (source === "mcp") {
        // Commit provenance before touching the file: interrupted approval must never
        // reload a partly saved MCP rule as a trusted human-authored rule.
        this.store.setMeta(`mcp_origin:${parsed.id}`, JSON.stringify([checkToYaml(parsed), path.resolve(file)]));
      } else {
        this.store.db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(`mcp_origin:${parsed.id}`, `approved_mcp:${parsed.id}`);
      }
    };
    if (target === "db") {
      this.store.upsertCheckRow({ id: parsed.id, kind: parsed.kind === "rule" ? "rule" : "question", source, path: null, body: checkToYaml(parsed) });
    } else {
      const dir = target === "user" ? this.userDir : target.dir;
      // A new <id>.yaml next to the file the check is loaded from would be shadowed by it (project
      // directories load after the user one, files in name order), so the edit would be ignored.
      const current = this.checks.get(parsed.id);
      const inPlace =
        current?.path &&
        (current.source === "user" || current.source === "project" || current.source === "mcp") &&
        (target === "user" || path.resolve(path.dirname(current.path)) === path.resolve(dir)) &&
        fs.existsSync(current.path)
          ? replaceInYaml(fs.readFileSync(current.path, "utf8"), parsed)
          : undefined;
      p = inPlace !== undefined ? current!.path! : path.join(dir, `${parsed.id}.yaml`);
      if (expectedPath && (path.resolve(p) !== path.resolve(expectedPath) || (current?.path && current.source !== "library" && path.resolve(current.path) !== path.resolve(expectedPath)))) throw new Error("manual target changed; refresh the proposal and review its current destination before saving");
      if (inPlace !== undefined) {
        if (source === "mcp") recordOrigin(p);
        fs.writeFileSync(p, inPlace, "utf8");
        if (source !== "mcp") recordOrigin(p);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        if (source === "mcp") recordOrigin(p);
        fs.writeFileSync(p, checkToYaml(parsed), "utf8");
        if (source !== "mcp") recordOrigin(p);
      }
      if (source === "planner") source = target === "user" ? "user" : "project";
      this.store.upsertCheckRow({ id: parsed.id, kind: parsed.kind === "rule" ? "rule" : "question", source, path: p, body: checkToYaml(parsed), enabled: parsed.enabled });
    }
    this.reload();
    return this.checks.get(parsed.id) ?? { check: parsed, source, path: p };
  }

  /** Removes a user or planner check (library checks can only be disabled). */
  remove(id: string): boolean {
    const lc = this.checks.get(id);
    if (!lc || lc.source === "library") return false;
    if (lc.path && fs.existsSync(lc.path)) {
      const { checks } = parseChecks(fs.readFileSync(lc.path, "utf8"));
      if (checks.length <= 1) fs.unlinkSync(lc.path);
      else {
        fs.writeFileSync(lc.path, YAML.stringify(checks.filter((c) => c.id !== id)), "utf8");
      }
    }
    this.store.db.prepare("DELETE FROM checks WHERE id = ?").run(id);
    this.store.db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(`mcp_origin:${id}`, `approved_mcp:${id}`);
    this.reload();
    return true;
  }

  /** Precision per check from dismissals; noisy checks are suggested for retirement. */
  precision(id: string): { hits: number; dismissed: number; precision: number | null; noisy: boolean } {
    const s = this.store.checkStats()[id];
    if (!s || s.hits === 0) return { hits: s?.hits ?? 0, dismissed: s?.dismissed ?? 0, precision: null, noisy: false };
    const precision = 1 - s.dismissed / s.hits;
    return { hits: s.hits, dismissed: s.dismissed, precision, noisy: s.hits >= 5 && precision < 0.4 };
  }
}
