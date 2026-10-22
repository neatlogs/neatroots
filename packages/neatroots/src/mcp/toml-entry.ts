// TOML entry scanning for the Codex config: find and remove our [mcp_servers.<name>]
// entry however it is spelled, leaving the rest of the file byte-for-byte.
//
// The same table can be spelled several ways: [mcp_servers."neatroots"] names the same
// table as [mcp_servers.neatroots], a definition can be dotted (mcp_servers.neatroots =
// { ... }), and a bracketed line inside a multi-line string is string content, not a
// table header. Quotes inside a # comment are comment, not code: a `# use \"\"\" for long
// strings` comment must never open a string that swallows the rest of the file. Missing
// a spelling adds a second definition of the same table, which is invalid TOML and stops
// the agent reading its whole config; treating string content as a header, comments as
// code, or a multi-line value as one line corrupts the file.
//
// Removal semantics follow the TOML grammar:
//   - our [table] is skipped header to header, so every value inside it — single-line,
//     multi-line string, or multi-line array — goes with it and cannot end the skip;
//   - a dotted key of ours goes with its whole value (single-line, multi-line string,
//     or multi-line array), then scanning resumes exactly as before the key;
//   - a header is only a header at bracket depth zero outside strings and comments,
//     so `[1, 2]` alone on a line inside a multi-line array is array content.
// A closing `"""` preceded by an ODD run of backslashes is escaped (the run's parity
// decides), so `s = """C:\\"""` is one closed string and never swallows the file.

import fs from "node:fs";

export const SERVER_NAME = "neatroots";
/** Names we have ever shipped under: stripped on removal, but not "connected" for status. */
export const LEGACY_NAMES = ["neatbolt"];

const OUR_NAMES = new Set([SERVER_NAME, ...LEGACY_NAMES]);

/** Key path of a dotted TOML key or header body, with quotes removed: 'a."b".c' -> [a, b, c]. */
function tomlKeyPath(text: string): string[] {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s"']+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    parts.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  }
  return parts;
}

/** Our entry: mcp_servers.<ours>, with anything below it (sub-tables, sub-keys). */
function isOursPath(full: string[]): boolean {
  return full[0] === "mcp_servers" && full.length >= 2 && OUR_NAMES.has(full[1]);
}

function tomlTablePath(line: string): string[] | null {
  const m = /^\[\[?([^\]]+)\]\]?\s*$/.exec(line.trim());
  return m ? tomlKeyPath(m[1]) : null;
}

/** A `"""` close at `at` is escaped when preceded by an odd number of backslashes. */
function escapedByRun(line: string, at: number): boolean {
  let run = 0;
  for (let i = at - 1; i >= 0 && line[i] === "\\"; i--) run++;
  return run % 2 === 1;
}

interface Walk {
  /** Everything before the first unquoted # (the part TOML parses as code). */
  code: string;
  /** The multi-line string left open after this line, if any. */
  ml: string | null;
  /** Net bracket depth of code outside strings and comments on this line. */
  depth: number;
}

/**
 * One pass over a line with full TOML awareness: a comment ends the code part,
 * single-line strings hide their contents, multi-line delimiters open and close
 * (parity of the backslash run decides for `"""`), and brackets only count outside
 * strings and comments. Every line goes through here, so header detection, key
 * detection and value tracking always agree on what is code.
 */
function walkLine(line: string, mlStart: string | null): Walk {
  let ml = mlStart;
  let depth = 0;
  const codeEnd = line.length;
  let i = 0;
  while (i < line.length) {
    if (ml) {
      const at = line.indexOf(ml, i);
      if (at < 0) return { code: line, ml, depth };
      if (ml === '"""' && escapedByRun(line, at)) {
        i = at + 3;
        continue;
      }
      ml = null;
      i = at + 3;
      continue;
    }
    const ch = line[i];
    if (ch === "#") return { code: line.slice(0, i), ml: null, depth };
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      ml = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < line.length && line[i] !== ch) i += ch === '"' && line[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    i++;
  }
  return { code: line.slice(0, codeEnd), ml, depth };
}

/**
 * Collapses the blank run at each removal seam to at most one blank line — the old
 * global /\n{3,}/ rewrite also rewrote blank lines inside other entries' multi-line
 * strings. Everywhere else the file is untouched.
 */
function collapseAtSeams(lines: string[], seams: number[]): string {
  const drop = new Set<number>();
  for (const s of new Set(seams)) {
    let a = s;
    let b = s;
    while (a > 0 && lines[a - 1].trim() === "") a--;
    while (b < lines.length && lines[b].trim() === "") b++;
    for (let i = a; i < b - 1; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

export interface TomlScan {
  text: string;
  /** The current server name is defined. */
  server: boolean;
  /** A legacy name is defined (stripped on removal, never "connected"). */
  legacy: boolean;
}

type Mode = "table" | "dotted" | null;

/**
 * Removes our entry however it is spelled, leaving everything else as written. Our
 * table is skipped header to header (every value inside it goes with it), and a dotted
 * key of ours is dropped with its whole value — after which scanning resumes exactly
 * as before the key.
 */
export function scanToml(text: string): TomlScan {
  const out: string[] = [];
  const seams: number[] = [];
  let server = false;
  let legacy = false;
  let mode: Mode = null;
  let beforeKey: Mode = null;
  let depth = 0;
  let ml: string | null = null;
  let table: string[] = [];

  const saw = (path: string[]) => {
    if (path[1] === SERVER_NAME) server = true;
    else legacy = true;
  };
  const drop = () => seams.push(out.length);
  const keep = (line: string) => out.push(line);
  /** A dotted key's value ended: resume whatever the key interrupted. */
  const endKey = () => {
    mode = beforeKey;
    beforeKey = null;
  };

  for (const line of text.split("\n")) {
    const wasMl = ml;
    const w = walkLine(line, ml);
    const atDepth = depth;
    ml = w.ml;
    depth += w.depth;

    if (wasMl) {
      // string continuation: never a header, never a key — only the current skip applies
      if (mode) drop();
      else keep(line);
      if (mode === "dotted" && !ml && depth <= 0) endKey();
      continue;
    }

    const t = w.code.trim();
    const header = atDepth === 0 && t.startsWith("[") ? tomlTablePath(t) : null;
    if (header) {
      table = header;
      depth = 0;
      beforeKey = null;
      if (isOursPath(header)) {
        mode = "table";
        saw(header);
        drop();
      } else {
        mode = null;
        keep(line);
      }
      continue;
    }

    if (!t) {
      // blank or comment-only line
      if (mode) drop();
      else keep(line);
      continue;
    }

    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    const path = Boolean(key) && !/[[\]{}]/.test(key) ? [...table, ...tomlKeyPath(key)] : null;
    if (path && isOursPath(path)) {
      saw(path);
      drop();
      beforeKey = mode;
      mode = "dotted";
      if (!ml && depth <= 0) endKey();
      continue;
    }

    if (mode === "dotted") {
      drop();
      if (!ml && depth <= 0) endKey();
      continue;
    }
    if (mode) {
      // our table: skip header to header, whatever the values look like
      drop();
      continue;
    }
    keep(line);
  }
  return { text: collapseAtSeams(out, seams), server, legacy };
}

export function stripTomlEntry(text: string): string {
  return scanToml(text).text;
}

/** Only the current server name counts as connected; legacy names are cleanup-only. */
export function tomlHas(file: string): boolean {
  return fs.existsSync(file) && scanToml(fs.readFileSync(file, "utf8")).server;
}
