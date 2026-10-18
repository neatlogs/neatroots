import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { AnyCheck, isQuestion, isRule, type Check, type CheckSource, type LoadedCheck } from "./types.js";
import type { Store } from "../store/db.js";
import { log } from "../util/log.js";

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
 * .neatroots/checks, then checks written by the planner or over MCP. A later source replaces
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
        for (const c of checks) next.set(c.id, { check: c, source, path: p });
      }
    };
    loadDir(this.libraryDir, "library");
    loadDir(this.userDir, "user");
    for (const d of this.projectDirs()) loadDir(d, "project");
    const rows = this.store.db
      .prepare("SELECT id, source, body FROM checks WHERE source IN ('planner', 'mcp')")
      .all() as { id: string; source: CheckSource; body: string }[];
    for (const r of rows) {
      if (next.has(r.id)) continue;
      const { checks } = parseChecks(r.body);
      if (checks[0]) next.set(r.id, { check: checks[0], source: r.source, path: null });
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
    return this.all().filter((c) => c.check.enabled !== false && (stats[c.check.id]?.enabled ?? 1) === 1);
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

  /**
   * Saves a check. `target` is "user" (~/.neatroots/checks), a project checks directory, or
   * "db" for planner-written checks that live only in the database until a person keeps them.
   * A check that already lives in a user or project file is updated in that file, unless
   * `target` names a different directory.
   */
  save(check: Check, target: "user" | "db" | { dir: string }, source: CheckSource = "user"): LoadedCheck {
    const parsed = AnyCheck.parse(check) as Check;
    if (source === "mcp") assertNoHaltFromAgent(parsed, this.checks.get(parsed.id)?.check);
    let p: string | null = null;
    if (target === "db") {
      this.store.upsertCheckRow({ id: parsed.id, kind: parsed.kind === "rule" ? "rule" : "question", source, path: null, body: checkToYaml(parsed) });
    } else {
      const dir = target === "user" ? this.userDir : target.dir;
      // A new <id>.yaml next to the file the check is loaded from would be shadowed by it (project
      // directories load after the user one, files in name order), so the edit would be ignored.
      const current = this.checks.get(parsed.id);
      const inPlace =
        current?.path &&
        (current.source === "user" || current.source === "project") &&
        (target === "user" || path.resolve(path.dirname(current.path)) === path.resolve(dir)) &&
        fs.existsSync(current.path)
          ? replaceInYaml(fs.readFileSync(current.path, "utf8"), parsed)
          : undefined;
      if (inPlace !== undefined) {
        p = current!.path!;
        fs.writeFileSync(p, inPlace, "utf8");
      } else {
        fs.mkdirSync(dir, { recursive: true });
        p = path.join(dir, `${parsed.id}.yaml`);
        fs.writeFileSync(p, checkToYaml(parsed), "utf8");
      }
      if (source === "planner" || source === "mcp") source = target === "user" ? "user" : "project";
      this.store.db.prepare("DELETE FROM checks WHERE id = ? AND source IN ('planner', 'mcp')").run(parsed.id);
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

/**
 * A halt rule stops the user's agent with the user's authority, so a coding agent (MCP) may not
 * create one, turn a check into one, or change one the user made (#256).
 */
function assertNoHaltFromAgent(next: Check, current: Check | undefined): void {
  const halts = (c: Check | undefined) => !!c && isRule(c) && c.action === "halt";
  if (halts(next)) throw new Error("halt rules must be created or enabled by you in the app or CLI; save it with action: flag, and the user can switch it to halt in the app");
  if (halts(current)) throw new Error(`"${next.id}" is a halt rule; halt rules must be created or changed by you in the app or CLI`);
}
