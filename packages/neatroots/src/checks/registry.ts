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

interface FoundCheck {
  doc: YAML.Document.Parsed;
  node: YAML.YAMLMap;
  /** The list holding the check; undefined when the check is the whole document. */
  list?: YAML.YAMLSeq;
}

/** Every check with this id in a checks file: a document of its own, or an entry of a list or `checks:`. */
function findChecks(text: string, id: string): FoundCheck[] {
  const isOurs = (n: unknown): n is YAML.YAMLMap => YAML.isMap(n) && n.get("id") === id && !!n.range;
  const found: FoundCheck[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) continue;
    const contents = doc.contents;
    if (isOurs(contents)) {
      found.push({ doc, node: contents });
      continue;
    }
    const wrapped = YAML.isMap(contents) ? contents.get("checks", true) : undefined;
    const list = YAML.isSeq(contents) ? contents : YAML.isSeq(wrapped) ? wrapped : undefined;
    for (const node of list?.items ?? []) if (isOurs(node)) found.push({ doc, node, list });
  }
  return found;
}

/** The text a check takes up: its document or its "- " entry (flow entries are cut by flowCuts). */
function textOf(text: string, { doc, node, list }: FoundCheck): [number, number] {
  const [start, end] = node.range!;
  if (!list) return [doc.range[0], doc.range[2]];
  // A block entry runs from the start of its "- " line to the end of its last line. Comments on the
  // dash line, or on lines between the dash and the check's first key, go with it.
  const marker = /(^|\n)[ \t]*-(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*$/.exec(text.slice(0, start));
  return [marker ? marker.index + marker[1].length : start, end];
}

/**
 * The text to cut from a flow list `[a, x, x, b]`: each run of removed entries, with the comma after
 * it, or for a run at the end of the list the comma before it, so `[a, x, x]` becomes `[a]`. A
 * comment after that comma belongs to the entry before it (`[a, # note` …) and stays.
 */
function flowCuts(text: string, list: YAML.YAMLSeq, gone: (n: unknown) => boolean): { start: number; end: number; with: string }[] {
  const range = (n: unknown) => (n as YAML.Node).range!;
  const items = list.items;
  const cuts: { start: number; end: number; with: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!gone(items[i])) continue;
    let j = i;
    while (j + 1 < items.length && gone(items[j + 1])) j++;
    if (j + 1 < items.length) cuts.push({ start: range(items[i])[0], end: range(items[j + 1])[0], with: "" });
    else if (i > 0) {
      const prevEnd = range(items[i - 1])[1];
      const gap = text.slice(prevEnd, range(items[i])[0]);
      // The separator comma, skipping comment text (between entries, every # starts a comment).
      let k = 0;
      for (; k < gap.length && gap[k] !== ","; k++) if (gap[k] === "#") k = gap.includes("\n", k) ? gap.indexOf("\n", k) : gap.length;
      if (gap.includes("#") && k < gap.length) {
        cuts.push({ start: prevEnd + k, end: prevEnd + k + 1, with: "" }, { start: range(items[i])[0], end: range(items[j])[1], with: "" });
      } else cuts.push({ start: prevEnd, end: range(items[j])[1], with: "" });
    }
    else cuts.push({ start: range(items[i])[0], end: range(items[j])[1], with: "" });
    i = j;
  }
  return cuts;
}

/** The checks and load errors a file yields, other than this id's, comparable before and after an edit. */
function otherContent(text: string, id: string): string {
  const { checks, errors } = parseChecks(text);
  return JSON.stringify({
    checks: checks.filter((c) => c.id !== id),
    // Line and column numbers move when text above them is cut.
    errors: errors.filter((e) => e.id !== id).map((e) => `${e.id ?? ""}|${e.message.replace(/\d+/g, "#")}`),
  });
}

/** True when a checks file holds nothing but comments, empty lists and empty `checks:` wrappers. */
function holdsNothing(text: string): boolean {
  return YAML.parseAllDocuments(text).every((doc) => {
    if (doc.errors.length) return false;
    const c = doc.contents;
    if (c === null || (YAML.isScalar(c) && c.value === null)) return true;
    if (YAML.isSeq(c)) return c.items.length === 0;
    const wrapped = YAML.isMap(c) && c.items.length === 1 ? c.get("checks", true) : undefined;
    return YAML.isSeq(wrapped) && wrapped.items.length === 0;
  });
}

/** A check can't be deleted without changing other checks in its file; the file is left as it is. */
export class CheckRemoveConflict extends Error {}

/**
 * Cuts every check with this id out of a checks file; all other text stays exactly as written:
 * comments, other checks (including ones that don't validate yet) and other documents. Throws when
 * another check uses a YAML anchor the removed one defines, since that check would stop loading,
 * and when the cut would change anything else the file yields.
 */
function removeFromYaml(text: string, id: string): string {
  const found = findChecks(text, id);
  const removed = (pos: number) => found.some(({ node }) => pos >= node.range![0] && pos < node.range![1]);
  for (const { doc, node, list } of found) {
    const anchors = new Set<string>();
    YAML.visit(node, { Node: (_, n) => void (n.anchor && anchors.add(n.anchor)) });
    if (node.anchor) anchors.add(node.anchor);
    if (!anchors.size) continue;
    YAML.visit(doc, {
      Alias: (_, a) => {
        if (!anchors.has(a.source) || !a.range || removed(a.range[0])) return;
        const user = list?.items.find((n) => YAML.isMap(n) && n.range && a.range![0] >= n.range[0] && a.range![0] < n.range[1]);
        const name = YAML.isMap(user) ? `check ${String(user.get("id"))}` : "another check";
        throw new CheckRemoveConflict(`can't delete check ${id}: ${name} uses its YAML anchor &${a.source}. Replace *${a.source} there with the value, then delete ${id}.`);
      },
    });
  }
  const cuts: { start: number; end: number; with: string }[] = [];
  const flowLists = new Set(found.flatMap((f) => (f.list?.flow ? [f.list] : [])));
  for (const list of flowLists) cuts.push(...flowCuts(text, list, (n) => found.some((g) => g.node === n)));
  for (const f of found) {
    if (f.list?.flow) continue;
    const [start, end] = textOf(text, f);
    const list = f.list;
    cuts.push({ start, end, with: "" });
    // Emptying a block `checks:` list would leave `checks:` with no value, which doesn't load; it
    // becomes `checks: []`, written on the key's own line (after any anchor or tag, before any
    // comment) so it is valid however the list was indented.
    if (list && list !== f.doc.contents && f.node === list.items[0] && list.items.every((n) => found.some((g) => g.node === n))) {
      const pair = YAML.isMap(f.doc.contents) ? f.doc.contents.items.find((p) => p.value === list) : undefined;
      const keyEnd = (pair?.key as YAML.Node | undefined)?.range?.[1];
      if (keyEnd === undefined) continue;
      const lineEnd = /\r?\n|$/.exec(text.slice(keyEnd))!.index;
      const rest = text.slice(keyEnd, keyEnd + lineEnd);
      const at = keyEnd + rest.slice(0, /\s#|$/.exec(rest)!.index).trimEnd().length;
      cuts.push({ start: at, end: at, with: " []" });
    }
  }
  // Cuts are offsets into the original text; any that overlap are merged first, so none is made
  // with offsets a previous cut has moved.
  const merged: typeof cuts = [];
  for (const c of cuts.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && c.start < last.end) {
      last.with += c.with;
      last.end = Math.max(last.end, c.end);
    } else merged.push({ ...c });
  }
  let out = text;
  for (const c of merged.reverse()) out = out.slice(0, c.start) + c.with + out.slice(c.end);
  if (otherContent(out, id) !== otherContent(text, id) || parseChecks(out).checks.some((c) => c.id === id)) {
    throw new CheckRemoveConflict(`can't delete check ${id} without changing other checks in its file, so the file was left as it is. Remove it from the file by hand.`);
  }
  return out;
}

/**
 * Rewrites every check with this id in a checks file and leaves all other text as written:
 * comments, other checks (including ones that don't validate yet) and other documents.
 * Returns undefined when the file has no check with this id.
 */
function replaceInYaml(text: string, check: Check): string | undefined {
  const spans = findChecks(text, check.id).map(({ node }) => ({ start: node.range![0], end: node.range![1], node }));
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
      const before = fs.readFileSync(lc.path, "utf8");
      const text = removeFromYaml(before, id);
      if (text === before) {
        /* edited by hand since it was loaded; nothing of this check left to remove */
      } else if (holdsNothing(text)) fs.unlinkSync(lc.path);
      else fs.writeFileSync(lc.path, text, "utf8");
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
