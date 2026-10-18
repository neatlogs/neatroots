import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { archiveDirectory } from "../src/audit/files.js";
import * as windows from "../src/audit/windows-acl.js";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const user = "S-1-5-21-123-456-789-1001";
const acl = (): windows.DirectoryAcl => ({ user, owner: user, protected: true, rules: [
  { sid: user, allow: true, full: true, inherit: true, here: true },
  { sid: "S-1-5-18", allow: true, full: true, inherit: true, here: true },
  { sid: "S-1-5-32-544", allow: true, full: true, inherit: true, here: true },
] });
const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("accepts only protected private ACLs with inheritable access for the current user", () => {
  expect(windows.privateDirectoryAcl(acl())).toBe(true);
  for (const change of [
    (a: windows.DirectoryAcl) => { a.protected = false; },
    (a: windows.DirectoryAcl) => { a.owner = "S-1-1-0"; },
    (a: windows.DirectoryAcl) => { a.rules.push({ sid: "S-1-1-0", allow: true, full: false, inherit: true, here: true }); },
    (a: windows.DirectoryAcl) => { a.rules[0].full = false; },
    (a: windows.DirectoryAcl) => { a.rules[0].inherit = false; },
    (a: windows.DirectoryAcl) => { a.rules[0].here = false; },
  ]) {
    const candidate = acl(); change(candidate); expect(windows.privateDirectoryAcl(candidate)).toBe(false);
  }
});

it("uses a hidden, bounded subprocess with fixed script arguments and JSON stdin", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(acl()));
  const selected = 'C:\\archive with spaces\\$not-code;雪';
  windows.windowsDirectoryAcl(selected, "validate");
  const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
  expect(Array.isArray(args)).toBe(true);
  expect(args!.join(" ")).not.toContain(selected);
  expect(options).toMatchObject({ windowsHide: true, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] });
  expect(JSON.parse((options as { input: string }).input)).toEqual({ directory: selected, mode: "validate" });
});

it("secures only newly created Windows directories and only inspects an existing selection", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-acl-adapter-")); temporary.push(temp);
  const created = path.join(temp, "created");
  const existing = path.join(temp, "existing"); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, "keep"), "untouched");
  const spy = vi.spyOn(windows, "windowsDirectoryAcl").mockImplementation(() => {});
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    archiveDirectory(created, true);
    expect(spy.mock.calls).toEqual([[created, "secure"], [created, "validate"]]);
    spy.mockClear();
    archiveDirectory(existing, true);
    expect(spy.mock.calls).toEqual([[existing, "validate"]]);
    spy.mockImplementation(() => { throw new Error("Windows archive directory ACL is too broad"); });
    expect(() => archiveDirectory(existing, true)).toThrow(/ACL is too broad/);
    expect(fs.readFileSync(path.join(existing, "keep"), "utf8")).toBe("untouched");
    expect(fs.readdirSync(existing)).toEqual(["keep"]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
