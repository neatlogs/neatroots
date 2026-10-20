import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveDirectory } from "../src/audit/files.js";
import { protectedSystemAlias } from "../src/audit/system-alias.js";

interface Node { uid: number; mode: number; target?: string; file?: boolean }
const directory = (mode = 0o755, uid = 0): Node => ({ uid, mode });
const link = (target: string, uid = 0): Node => ({ uid, mode: 0o777, target });

/** Simulated POSIX metadata: no root-owned host paths are created or changed. */
function filesystem(nodes: Record<string, Node>) {
  const lookup = (file: fs.PathLike): fs.Stats => {
    const n = nodes[String(file)];
    if (!n) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
    return { uid: n.uid, mode: n.mode, isDirectory: () => !n.target && !n.file,
      isSymbolicLink: () => !!n.target, isFile: () => !!n.file } as fs.Stats;
  };
  vi.spyOn(fs, "lstatSync").mockImplementation(lookup);
  vi.spyOn(fs, "statSync").mockImplementation(lookup);
  vi.spyOn(fs, "readlinkSync").mockImplementation((file) => nodes[String(file)].target!);
}
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform === "win32")("protected POSIX system aliases (simulated metadata)", () => {
  it.each([
    ["/var", "/private/var", 0o755],
    ["/tmp", "/private/tmp", 0o1777],
    ["/home", "/var/home", 0o755],
  ])("accepts %s as a protected ancestor, including sticky system temp directories", (alias, target, mode) => {
    filesystem({ "/": directory(), "/private": directory(), "/var": directory(),
      [alias]: link(target), [target]: directory(mode), [`${alias}/audit`]: directory(0o700, 1000) });
    expect(archiveDirectory(`${alias}/audit`)).toBe(`${alias}/audit`);
    expect(() => archiveDirectory(alias)).toThrow(/unsafe/);
  });

  it.each(["link owner", "target owner", "target permissions", "target parent", "source parent", "source permissions", "target link", "file target"])("rejects an unsafe %s", (unsafe) => {
    const nodes: Record<string, Node> = { "/": directory(), "/system": directory(), "/private": directory(),
      "/system/alias": link("/private/data"), "/private/data": directory(), "/system/alias/audit": directory(0o700, 1000) };
    if (unsafe === "link owner") nodes["/system/alias"].uid = 1000;
    if (unsafe === "target owner") nodes["/private/data"].uid = 1000;
    if (unsafe === "target permissions") nodes["/private/data"].mode = 0o777;
    if (unsafe === "target parent") nodes["/private"].mode = 0o775;
    if (unsafe === "source parent") nodes["/system"].uid = 1000;
    if (unsafe === "source permissions") nodes["/system"].mode = 0o777;
    if (unsafe === "target link") { nodes["/private/data"] = link("/elsewhere", 1000); nodes["/elsewhere"] = directory(); }
    if (unsafe === "file target") nodes["/private/data"].file = true;
    filesystem(nodes);
    expect(() => archiveDirectory("/system/alias/audit")).toThrow(/unsafe/);
  });

  it("rejects a cyclic root-owned alias chain", () => {
    filesystem({ "/": directory(), "/var": link("/tmp"), "/tmp": link("/var"), "/var/audit": directory(0o700, 1000) });
    expect(() => archiveDirectory("/var/audit")).toThrow(/unsafe/);
  });

  it("never allows aliases for native Windows, and uses native POSIX semantics during ACL adapter simulation", () => {
    filesystem({ "/": directory(), "/var": link("/private/var"), "/private": directory(),
      "/private/var": directory(), "/var/audit": directory(0o700, 1000) });
    expect(protectedSystemAlias("/var", "win32")).toBe(false);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try { expect(archiveDirectory("/var/audit")).toBe("/var/audit"); }
    finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("refuses to normalize away unchecked target parent traversals", () => {
    filesystem({ "/": directory(), "/var": link("/unsafe/../private/var"), "/private": directory(),
      "/private/var": directory(), "/var/audit": directory(0o700, 1000) });
    expect(() => archiveDirectory("/var/audit")).toThrow(/unsafe/);
  });

  it("supports protected relative parent targets without skipping directory checks", () => {
    filesystem({ "/": directory(), "/var": directory(), "/run": directory(),
      "/var/run": link("../run"), "/var/run/audit": directory(0o700, 1000) });
    expect(archiveDirectory("/var/run/audit")).toBe("/var/run/audit");
  });
});

it.runIf(process.platform === "linux" && fs.existsSync("/bin") && fs.lstatSync("/bin").isSymbolicLink())("accepts the native Linux /bin system alias without changing it", () => {
  expect(protectedSystemAlias("/bin")).toBe(true);
});
