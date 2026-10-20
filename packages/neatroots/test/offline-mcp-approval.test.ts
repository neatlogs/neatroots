import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { checkFiles } from "../src/checks/offline.js";
import { CheckRegistry } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { makeRoots, hex, span } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0)) await close(); });
const check = { id: "offline-origin", kind: "rule", action: "flag", rule: { type: "match", field: "name", pattern: "done" } } as Check;
function diskState(home: string) {
  const dir = path.join(home, "data");
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /\.db(?:-wal|-journal)?$/.test(f)).map((f) => [f, fs.readFileSync(path.join(dir, f)).toString("hex")]));
}
it.each(["edited", "recovered", "approved", "legacy", "moved", "disabled", "missing", "pending", "shadow", "human"])("offline and built CLI preserve %s MCP approval truth without changing persisted application data", async (mode) => {
  const t = await makeRoots({ noEngine: true }); cleanup.push(t.close); vi.stubEnv("NEATROOTS_HOME", t.roots.home);
  const p = t.roots.checks.proposeMcp(check, null);
  if (mode === "recovered") {
    const original = t.roots.store.upsertCheckRow.bind(t.roots.store);
    const fault = vi.spyOn(t.roots.store, "upsertCheckRow").mockImplementation((row) => { if (row.id === check.id) throw new Error("interrupted"); return original(row); });
    try { expect(() => t.roots.checks.approvePendingMcp(check.id, p.revision)).toThrow("interrupted"); } finally { fault.mockRestore(); }
  } else t.roots.checks.approvePendingMcp(check.id, p.revision);
  const file = p.target_path;
  if (mode === "pending") t.roots.checks.proposeMcp({ ...check, title: "new pending version" }, null);
  if (mode === "shadow") fs.copyFileSync(file, path.join(path.dirname(file), "zz-shadow.yaml"));
  if (mode === "edited") fs.appendFileSync(file, "title: edited since approval\n");
  if (mode === "moved") fs.renameSync(file, path.join(path.dirname(file), "renamed.yaml"));
  if (mode === "legacy") { t.roots.store.db.prepare("DELETE FROM meta WHERE key=? OR key=?").run(`mcp_origin:${check.id}`, `approved_mcp:${check.id}`); }
  if (mode === "missing") fs.unlinkSync(file);
  if (mode === "disabled") t.roots.store.setCheckEnabled(check.id, false);
  if (mode === "human") t.roots.checks.save(check, "user");
  const reopened = new CheckRegistry(t.roots.store, path.dirname(file), () => []);
  const active = mode === "approved" || mode === "human" || mode === "pending";
  expect(reopened.rules().some((c) => c.check.id === check.id)).toBe(active);
  const trace = path.join(t.roots.home, "trace.json");
  fs.writeFileSync(trace, JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [span({ traceId: hex(16), name: "done", kind: "workflow" })] }] }] }));
  const before = diskState(t.roots.home);
  const r = checkFiles([trace]);
  expect.soft(r.rules.includes(check.id)).toBe(active);
  expect.soft(r.runs[0].findings.some((f) => f.check_id === check.id)).toBe(active);
  const cli = spawnSync(process.execPath, ["dist/cli.js", "check", trace, "--json"], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" });
  expect.soft(cli.status, cli.stderr).toBe(r.runs.some((run) => run.findings.length) ? 1 : 0);
  const output = JSON.parse(cli.stdout);
  expect.soft(output.rules.includes(check.id)).toBe(active);
  expect.soft(output.runs[0].findings.some((f: { check_id: string }) => f.check_id === check.id)).toBe(active);
  expect(diskState(t.roots.home)).toEqual(before);
});
it("explicit repository checks with an isolated home exclude ambient config directories and DB-only bodies", async () => {
  const t = await makeRoots({ noEngine: true }); cleanup.push(t.close); vi.stubEnv("NEATROOTS_HOME", t.roots.home);
  const repo = path.join(t.roots.home, "repo-checks"), ambient = path.join(t.roots.home, "ambient");
  fs.mkdirSync(repo); fs.mkdirSync(ambient);
  const yaml = (id: string) => `id: ${id}\nkind: rule\nrule: { type: match, field: name, pattern: done }\n`;
  fs.writeFileSync(path.join(repo, "repo.yaml"), yaml("repo-only")); fs.writeFileSync(path.join(ambient, "ambient.yaml"), yaml("ambient-only"));
  fs.writeFileSync(path.join(t.roots.home, "config.yaml"), `checkDirs: [${JSON.stringify(ambient)}]\n`);
  t.roots.checks.save({ ...check, id: "db-only" }, "db");
  t.roots.store.upsertCheckRow({ id: "ambient-planner", kind: "rule", source: "planner", path: path.join(ambient, "missing.yaml"), body: yaml("ambient-planner") });
  const trace = path.join(t.roots.home, "trace.json"); fs.writeFileSync(trace, JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span({ traceId: hex(16), name: "done", kind: "workflow" })] }] }] }));
  const before = diskState(t.roots.home);
  const r = checkFiles([trace], { dirs: [repo] });
  expect(r.rules).toContain("repo-only"); expect(r.rules).not.toContain("ambient-only"); expect(r.rules).not.toContain("db-only"); expect(r.rules).not.toContain("ambient-planner");
  const cli = spawnSync(process.execPath, ["dist/cli.js", "check", trace, "--checks", repo, "--json"], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" });
  expect(cli.status, cli.stderr).toBe(1); expect(JSON.parse(cli.stdout).rules).toEqual(r.rules); expect(diskState(t.roots.home)).toEqual(before);
  const absent = path.join(t.roots.home, "fresh-ci");
  const fresh = spawnSync(process.execPath, ["dist/cli.js", "check", trace, "--checks", repo, "--only", "repo-only", "--json"], { cwd: process.cwd(), env: { ...process.env, NEATROOTS_HOME: absent }, encoding: "utf8" });
  expect(fresh.status, fresh.stderr).toBe(1); expect(JSON.parse(fresh.stdout).rules).toEqual(["repo-only"]); expect(fs.existsSync(absent)).toBe(false);
});