import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RootsConfig } from "../src/config.js";
import { TOOLS } from "../src/mcp/tools.js";
import { makeRoots, type TestRoots } from "./helpers.js";

// POST /api/settings used to push any check_dir string onto config.checkDirs and then reload,
// which threw out of readdirSync when the path wasn't a directory: the request answered 500, the
// push stayed in memory, and the next settings save wrote the poisoned list to config.yaml, where
// the next start died inside CheckRegistry (#224).

let scratch: string;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-checkdir-"));
});

afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function served(config?: (c: RootsConfig) => void): Promise<TestRoots> {
  const tb = await makeRoots({ serve: true, noEngine: true, ...(config ? { config } : {}) });
  cleanup.push(tb.close);
  return tb;
}

const save = (tb: TestRoots, b: unknown) =>
  fetch(`${tb.url}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: tb.url.replace("127.0.0.1", "localhost") },
    body: JSON.stringify(b),
  });

const savedConfig = (tb: TestRoots) => YAML.parse(fs.readFileSync(path.join(tb.roots.home, "config.yaml"), "utf8")) as { checkDirs?: string[] };

/** One MCP tool, called the way the server calls it. */
function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool named ${name}`);
  return t;
}

function checkFile(): string {
  const file = path.join(scratch, "not-a-checks-dir");
  fs.writeFileSync(file, "x\n");
  return file;
}

it("refuses a check_dir that isn't a directory, and the next save doesn't persist it", async () => {
  const tb = await served();
  const file = checkFile();

  const refused = await save(tb, { check_dir: file });
  expect(refused.status).toBe(400); // was 500 {"error":"internal error"}
  expect(((await refused.json()) as { error: string }).error).toMatch(/directory/);
  expect(tb.roots.config.checkDirs).toEqual([]); // was [file]

  // The next save is an ordinary one. It must not carry the refused path into config.yaml.
  expect((await save(tb, { retention_days: 21 })).status).toBe(200);
  expect(tb.roots.config.checkDirs).toEqual([]);
  expect(savedConfig(tb).checkDirs ?? []).toEqual([]);
  expect(fs.readFileSync(path.join(tb.roots.home, "config.yaml"), "utf8")).not.toContain(path.basename(file));
  expect(tb.roots.config.retention.days).toBe(21); // the valid part of that request still saves
});

it("refuses check_dir values that can't be used as a directory", async () => {
  const tb = await served();
  const file = checkFile();

  const cases: [unknown, RegExp][] = [
    [file, /is a file, not a directory/],
    // A path under a file is ENOENT on Windows and ENOTDIR elsewhere; either way a save can never
    // create it, and the message names the file in the way.
    [path.join(file, "sub"), /sits under .*, which is a file, not a directory/],
    ["", /must be a directory path/],
    ["   ", /must be a directory path/],
    [5, /must be a directory path/],
    [null, /must be a directory path/],
    // Relative to the server's working folder, which isn't the caller's, so it means nothing here.
    ["checks", /must be an absolute path/],
    [path.join(".neatroots", "checks"), /must be an absolute path/],
  ];
  for (const [bad, expected] of cases) {
    const r = await save(tb, { check_dir: bad });
    expect(r.status, JSON.stringify(bad)).toBe(400);
    expect(((await r.json()) as { error: string }).error, JSON.stringify(bad)).toMatch(expected);
  }
  expect(tb.roots.config.checkDirs).toEqual([]);
});

it("refuses a check_dir under a link that points nowhere", async () => {
  const tb = await served();
  const link = path.join(scratch, "gone");
  try {
    // A junction needs no privilege on Windows; the target is deliberately not there.
    fs.symlinkSync(path.join(scratch, "nowhere"), link, "junction");
  } catch {
    return; // creating a link needs a privilege Windows does not always grant
  }
  // existsSync is false here, so a save would have to mkdir through the link and fail with ENOENT.
  const r = await save(tb, { check_dir: path.join(link, "checks") });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toMatch(/sits under .*, which is a file, not a directory/);
  expect(tb.roots.config.checkDirs).toEqual([]);
});

it("registers a checks directory that isn't there yet, and the first save creates it", async () => {
  const tb = await served();
  const dir = path.join(scratch, "fresh", "checks"); // neither folder exists yet

  // CheckRegistry.save() makes the folder, so this has to be accepted: a fresh clone, and a
  // `.neatroots/checks` that was deleted, are the cases the Checks page and create_check work from.
  expect((await save(tb, { check_dir: dir })).status).toBe(200); // was 400 "does not exist"
  expect(tb.roots.config.checkDirs).toEqual([dir]);
  expect(savedConfig(tb).checkDirs).toEqual([dir]);

  const yaml = "id: fresh-check\nkind: rule\nrule: { type: count, span: { type: tool, name: lookup }, at_least: 3 }\n";
  const res = await fetch(`${tb.url}/api/checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml, dir }),
  });

  expect(res.status).toBe(200);
  const saved = path.join(dir, "fresh-check.yaml");
  expect(((await res.json()) as { path: string }).path).toBe(saved);
  expect(fs.existsSync(saved)).toBe(true);
  expect(tb.roots.checks.get("fresh-check")).toBeTruthy();

  // MCP proposals defer file creation until a person approves the exact revision.
  const mcpDir = path.join(scratch, "fresh-mcp", "checks");
  tb.roots.config.checkDirs.push(mcpDir);
  const out = (await tool("create_check").run(tb.roots, { check: yaml.replace("fresh-check", "mcp-check"), dir: mcpDir })) as { path: null; revision: string; pending_approval: boolean };
  expect(out.path).toBeNull();
  expect(out.pending_approval).toBe(true);
  expect(fs.existsSync(mcpDir)).toBe(false);
  expect(tb.roots.checks.get("mcp-check")).toBeUndefined();
  const approval = await fetch(`${tb.url}/api/checks/mcp-check/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: out.revision }),
  });
  expect(approval.status).toBe(200);
  const mcpPath = path.join(mcpDir, "mcp-check.yaml");
  expect(((await approval.json()) as { path: string }).path).toBe(mcpPath);
  expect(fs.existsSync(mcpPath)).toBe(true);
  expect(tb.roots.checks.get("mcp-check")?.source).toBe("mcp");
  expect(tb.roots.checks.isApprovedMcp("mcp-check")).toBe(true);
});

it("refuses a save into a registered directory a save can't use", async () => {
  const dir = path.join(scratch, "gone-bad");
  fs.mkdirSync(dir);
  const tb = await served((c) => (c.checkDirs = [dir]));
  // The shape a config from before this fix ends up in: the registered directory is now a file.
  // Both callers used to reach mkdirSync and answer 500 (POST) or throw EEXIST (MCP).
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "x\n");
  const yaml = "id: later-check\nkind: rule\nrule: { type: count, span: { type: tool, name: lookup }, at_least: 3 }\n";

  const res = await fetch(`${tb.url}/api/checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml, dir }),
  });
  expect(res.status).toBe(400); // was 500 {"error":"internal error"}
  expect(((await res.json()) as { error: string }).error).toMatch(/is a file, not a directory/);

  await expect(tool("create_check").run(tb.roots, { check: yaml, dir })).rejects.toThrow(/is a file, not a directory/);
});

it("registers a real checks directory and loads its checks", async () => {
  const tb = await served();
  const dir = path.join(scratch, "checks");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "team.yaml"), "id: team-check\nkind: rule\nrule: { type: count, span: { type: tool, name: lookup }, at_least: 3 }\n");

  expect((await save(tb, { check_dir: dir })).status).toBe(200);

  expect(tb.roots.config.checkDirs).toEqual([dir]);
  expect(tb.roots.checks.get("team-check")).toBeTruthy();
  expect(savedConfig(tb).checkDirs).toEqual([dir]);

  // Padding and a trailing separator are normalized, so one directory stays one entry that still
  // resolves to the same place on the next start.
  expect((await save(tb, { check_dir: `  ${dir}${path.sep}  ` })).status).toBe(200);
  expect(tb.roots.config.checkDirs).toEqual([dir]);
});

it("refuses a registered check_dir that stopped being a directory", async () => {
  const dir = path.join(scratch, "checks");
  fs.mkdirSync(dir);
  const tb = await served((c) => (c.checkDirs = [dir]));
  // The directory is replaced by a file, the shape a config from before this fix ends up in.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "x\n");

  const r = await save(tb, { check_dir: dir });

  expect(r.status).toBe(400); // was 200: the entry was already registered, so nothing looked at it
  expect(((await r.json()) as { error: string }).error).toMatch(/is a file, not a directory/);
  expect(tb.roots.config.checkDirs).toEqual([dir]); // unchanged: the request adds and changes nothing
});

it("starts and reports a checks directory that a config already holds but can't read", async () => {
  const file = checkFile();
  // A config from before this fix: the constructor used to throw ENOTDIR here, before the server listened.
  const tb = await served((c) => (c.checkDirs = [file]));

  expect(tb.roots.checks.errors.map((e) => e.path)).toContain(file);
  const listed = (await (await fetch(`${tb.url}/api/checks`)).json()) as { checks: unknown[]; errors: { path: string }[] };
  expect(listed.errors.map((e) => e.path)).toContain(file);
  expect(listed.checks.length).toBeGreaterThan(0); // the library still loads
});

it("a check file it can't read is one bad file, not a 500 and not a crash", async () => {
  const tb = await served();
  const dir = path.join(scratch, "checks");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "team.yaml"), "id: team-check\nkind: rule\nrule: { type: count, span: { type: tool, name: lookup }, at_least: 3 }\n");
  // A directory whose name ends in .yaml passes the extension filter and throws EISDIR on read.
  // A broken symlink throws ENOENT. Either one used to throw out of reload().
  fs.mkdirSync(path.join(dir, "draft.yaml"));
  try {
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "gone.yaml"));
  } catch {
    // Creating a symlink needs a privilege Windows does not always grant; the directory case still covers the guard.
  }

  expect((await save(tb, { check_dir: dir })).status).toBe(200);

  expect(tb.roots.config.checkDirs).toEqual([dir]);
  expect(tb.roots.checks.get("team-check")).toBeTruthy(); // the good file in the same directory still loads
  const reported = tb.roots.checks.errors.map((e) => e.path);
  expect(reported).toContain(path.join(dir, "draft.yaml"));
  // The path was usable, so it stays in the config and the next start can use it.
  expect(savedConfig(tb).checkDirs).toEqual([dir]);
});
