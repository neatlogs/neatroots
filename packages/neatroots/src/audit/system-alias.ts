import fs from "node:fs";
import path from "node:path";

// Tests may override process.platform for the ACL adapter; filesystem semantics stay native.
const nativePlatform = process.platform;

const protectedDirectory = (st: fs.Stats): boolean => st.isDirectory() && st.uid === 0
  && (!(st.mode & 0o022) || !!(st.mode & 0o1000));

/** Every parent and target must be root-controlled; a root-owned link alone is insufficient. */
function protectedPath(input: string, visiting: Set<string>): string | null {
  let current = path.parse(input).root;
  if (!current || !protectedDirectory(fs.lstatSync(current))) return null;
  for (const part of input.slice(current.length).split(path.sep).filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    const st = fs.lstatSync(next);
    if (!st.isSymbolicLink()) {
      if (!protectedDirectory(st)) return null;
      current = next;
      continue;
    }
    if (st.uid !== 0 || visiting.has(next) || visiting.size >= 40) return null;
    const target = fs.readlinkSync(next);
    visiting.add(next);
    // Keep parent steps until traversal: path.resolve/join would skip their permission checks.
    const resolved = protectedPath(path.isAbsolute(target) ? target : `${current}${path.sep}${target}`, visiting);
    visiting.delete(next);
    if (resolved === null) return null;
    current = resolved;
  }
  return current;
}

/** Allow protected POSIX system aliases, including root-owned sticky temp targets, never Windows links. */
export function protectedSystemAlias(file: string, platform = nativePlatform): boolean {
  if (platform === "win32") return false;
  try {
    const parent = protectedPath(path.dirname(file), new Set());
    if (parent === null) return false;
    const canonical = path.join(parent, path.basename(file));
    const st = fs.lstatSync(canonical);
    if (!st.isSymbolicLink() || st.uid !== 0) return false;
    const target = fs.readlinkSync(canonical);
    return protectedPath(path.isAbsolute(target) ? target : `${parent}${path.sep}${target}`, new Set([canonical])) !== null;
  } catch {
    return false;
  }
}
