import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });
const post = (body: object) => fetch(`${t!.url}/api/settings`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

for (const kind of ["root", "file", "child under file", "leaf link", "ancestor link"] as const) {
  it(`rejects an audit directory that is a ${kind} before saving any settings`, async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const roots = t.roots, configFile = path.join(roots.home, "config.yaml");
    roots.saveConfig();
    const original = fs.readFileSync(configFile), policy = structuredClone(roots.config);
    const target = path.join(roots.home, "target");
    let directory = path.parse(roots.home).root;
    if (kind === "file" || kind === "child under file") {
      fs.writeFileSync(target, "not a directory");
      directory = kind === "file" ? target : path.join(target, "future", "archive");
    } else if (kind === "leaf link" || kind === "ancestor link") {
      fs.mkdirSync(target, { mode: 0o700 });
      const link = path.join(roots.home, "user-link");
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      directory = kind === "leaf link" ? link : path.join(link, "future", "archive");
    }
    const save = vi.spyOn(roots, "saveConfig");
    const chmod = vi.spyOn(fs, "chmodSync");
    const events = vi.fn(); const off = roots.bus.on("settings", events);
    const response = await post({ audit_directory: directory, audit_enabled: true, retention_days: 7 });
    expect.soft(response.status).toBe(400);
    expect.soft(await response.json()).toMatchObject({ error: expect.stringMatching(/audit.*directory/i) });
    expect.soft(save).not.toHaveBeenCalled();
    expect.soft(chmod).not.toHaveBeenCalled();
    expect.soft(fs.readFileSync(configFile)).toEqual(original);
    expect.soft(roots.config).toEqual(policy);
    expect.soft(events).not.toHaveBeenCalled();
    if (kind === "ancestor link") expect.soft(fs.existsSync(path.join(target, "future"))).toBe(false);
    off();
  });
}

it("accepts missing nested directories without creating them", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const directory = path.join(t.roots.home, "future", "nested", "archive");
  const response = await post({ audit_directory: directory });
  expect(response.status).toBe(200);
  expect(t.roots.config.audit.directory).toBe(directory);
  expect(fs.existsSync(path.join(t.roots.home, "future"))).toBe(false);
});

it("accepts an existing private directory without changing it", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const directory = path.join(t.roots.home, "archive");
  fs.mkdirSync(directory, { mode: 0o700 });
  const before = fs.statSync(directory).mode;
  const chmod = vi.spyOn(fs, "chmodSync");
  expect((await post({ audit_directory: directory })).status).toBe(200);
  expect(t.roots.config.audit.directory).toBe(directory);
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(fs.statSync(directory).mode).toBe(before);
  expect(chmod).not.toHaveBeenCalled();
});

it("keeps the empty-directory default behavior", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  expect((await post({ audit_directory: "" })).status).toBe(200);
  expect(t.roots.config.audit.directory).toBe("");
  expect(t.roots.audit.directory()).toBe(path.join(t.roots.home, "audit"));
  expect(fs.existsSync(t.roots.audit.directory())).toBe(false);
});

it.skipIf(process.platform === "win32")("accepts a protected system ancestor alias through HTTP without filesystem changes", async () => {
  t = await makeRoots({ noEngine: true, serve: true });
  const alias = "/neatroots-protected-alias", target = "/neatroots-protected-target";
  const lstat = fs.lstatSync;
  // Only synthetic alias/target metadata is substituted; HTTP, config persistence and
  // protectedSystemAlias's ownership/permission traversal remain real code.
  vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
    const name = String(file);
    if (name === alias || name === target) return {
      uid: 0, mode: 0o755, isSymbolicLink: () => name === alias,
      isDirectory: () => name === target, isFile: () => false,
    } as fs.Stats;
    if (name.startsWith(alias + "/")) throw Object.assign(new Error("missing future directory"), { code: "ENOENT" });
    return lstat(file, options as any) as fs.Stats;
  });
  const readlink = fs.readlinkSync;
  vi.spyOn(fs, "readlinkSync").mockImplementation((file, options) =>
    String(file) === alias ? target : readlink(file, options as any));
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const chmod = vi.spyOn(fs, "chmodSync");
  expect((await post({ audit_directory: alias + "/future/archive" })).status).toBe(200);
  expect(t.roots.config.audit.directory).toBe(alias + "/future/archive");
  expect(mkdir.mock.calls.some(([p]) => String(p).startsWith(alias))).toBe(false);
  expect(chmod).not.toHaveBeenCalled();
});
