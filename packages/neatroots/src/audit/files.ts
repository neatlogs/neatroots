import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { windowsDirectoryAcl } from "./windows-acl.js";

export const sha256 = (bytes: string | Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** Reject ambiguous paths and every existing symlink component, including the selected root. */
export function archiveDirectory(input: string, create = false): string {
  if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) throw new Error("invalid archive directory");
  const dir = path.resolve(input);
  if (dir === path.parse(dir).root) throw new Error("archive directory cannot be a filesystem root");
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe archive directory component: ${current}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
      fs.mkdirSync(current, { mode: 0o700 });
      if (process.platform === "win32") windowsDirectoryAcl(current, "secure");
      syncDirectory(path.dirname(current));
    }
  }
  if (create) {
    if (process.platform === "win32") windowsDirectoryAcl(dir, "validate");
    else if (fs.statSync(dir).mode & 0o077) throw new Error("archive directory must have user-only permissions (chmod 700)");
  }
  return dir;
}

export function syncDirectory(dir: string): void {
  // Windows does not support opening directories with fs.open; file handles are still synced.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readFile(file: string): Buffer {
  const before = fs.lstatSync(file);
  const regular = (st: fs.Stats) => st.isFile() && !st.isSymbolicLink() && st.nlink === 1;
  const sameFile = (st: fs.Stats) => regular(st) && st.dev === before.dev && st.ino === before.ino;
  if (!regular(before)) throw new Error(`unsafe archive file: ${file}`);
  // NONBLOCK also protects the gap after lstat if a regular file is replaced with a FIFO.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(fs.fstatSync(fd)) || !sameFile(fs.lstatSync(file))) throw new Error(`unsafe archive file: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (!sameFile(fs.fstatSync(fd)) || !sameFile(fs.lstatSync(file))) throw new Error(`archive file changed while reading: ${file}`);
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Exclusive publication: an existing destination can never be overwritten. */
export function atomicFile(file: string, bytes: Buffer): void {
  const temp = path.join(path.dirname(file), `.pending-${crypto.randomUUID()}`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // A hard link publishes all bytes atomically, unlike rename which can replace a destination.
  fs.linkSync(temp, file);
  fs.unlinkSync(temp);
  syncDirectory(path.dirname(file));
}
