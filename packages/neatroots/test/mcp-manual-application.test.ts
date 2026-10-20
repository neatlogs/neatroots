import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Check } from "../src/checks/types.js";
import { makeRoots } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

it("an external editor at the final snapshot boundary is never overwritten by approval", async () => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  const check = { id: "external-race", kind: "rule", action: "flag", rule: { type: "count", at_least: 3 } } as Check;
  const active = t.roots.checks.save(check, "user");
  t.roots.store.db.prepare("UPDATE checks SET hits=7,dismissed=2,confirmed=1 WHERE id=?").run(check.id);
  const proposal = t.roots.checks.proposeMcp({ ...check, rule: { type: "count", at_least: 1 } } as Check, null);
  const stats = t.roots.store.checkStats()[check.id];
  const meta = t.roots.store.db.prepare("SELECT * FROM meta WHERE key != 'search_index' ORDER BY key").all();
  const external = `id: ${check.id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 9 }\n# concurrent editor content\n`;
  let reads = 0, edits = 0;
  const read = fs.readFileSync;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const result = read(file, options as never);
    if (String(file) === active.path && Buffer.isBuffer(result) && !new Error().stack?.includes("fromMcpProposal") && ++reads === 2) { fs.writeFileSync(active.path!, external); edits++; }
    return result;
  }) as typeof fs.readFileSync);
  let response: Response;
  try { response = await fetch(`${t.url}/api/checks/${check.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: proposal.revision }) }); }
  finally { spy.mockRestore(); }
  expect(edits).toBe(1);
  expect.soft(response!.status).toBe(409);
  expect.soft(await response!.json()).toMatchObject({ code: "manual_application_required", target_path: active.path });
  expect.soft(fs.readFileSync(active.path!, "utf8")).toBe(external);
  expect.soft(t.roots.store.db.prepare("SELECT * FROM meta WHERE key != 'search_index' ORDER BY key").all()).toEqual(meta);
  expect.soft(t.roots.store.checkStats()[check.id]).toEqual(stats);
  expect.soft(t.roots.checks.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
  expect.soft(t.roots.checks.isApprovedMcp(check.id)).toBe(false);
});
it.each(["human", "approved", "recovered", "identical", "disabled", "shared", "directory", "symlink"])("existing %s destinations require manual application without any write or approval state change", async (mode) => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  const check = { id: "existing-policy", kind: "rule", action: "flag", rule: { type: "count", at_least: 3 } } as Check;
  const dir = path.join(t.roots.home, "checks"), file = path.join(dir, `${check.id}.yaml`);
  if (mode === "recovered") {
    const p = t.roots.checks.proposeMcp(check, null), upsert = t.roots.store.upsertCheckRow.bind(t.roots.store);
    const fault = vi.spyOn(t.roots.store, "upsertCheckRow").mockImplementation((row) => { if (row.id === check.id) throw new Error("interrupted new approval"); return upsert(row); });
    try { expect(() => t.roots.checks.approvePendingMcp(check.id, p.revision)).toThrow("interrupted new approval"); } finally { fault.mockRestore(); }
  } else if (mode === "approved" || mode === "disabled") {
    const p = t.roots.checks.proposeMcp(check, null); t.roots.checks.approvePendingMcp(check.id, p.revision);
  } else if (mode === "directory") { fs.mkdirSync(file, { recursive: true }); }
  else {
    t.roots.checks.save(check, "user");
    if (mode === "shared") fs.appendFileSync(file, "---\nid: unrelated-policy\nkind: rule\nrule: { type: count, at_least: 7 }\n");
    if (mode === "symlink") { const actual = path.join(t.roots.home, "actual.yaml"); fs.renameSync(file, actual); fs.symlinkSync(actual, file); }
  }
  if (mode === "disabled") t.roots.store.setCheckEnabled(check.id, false);
  t.roots.checks.reload();
  const pending = t.roots.checks.proposeMcp(mode === "identical" ? check : { ...check, title: "Proposed change" }, null);
  expect(pending.manual_application_required).toBe(true);
  expect(pending.target_path).toBe(file);
  const row = t.roots.store.getMcpCheckProposal(check.id), stats = t.roots.store.checkStats()[check.id];
  const meta = t.roots.store.db.prepare("SELECT * FROM meta WHERE key != 'search_index' ORDER BY key").all();
  const bytes = mode === "directory" ? undefined : fs.readFileSync(file);
  const active = t.roots.checks.enabled().some((c) => c.check.id === check.id);
  const write = vi.spyOn(fs, "writeFileSync");
  const response = await fetch(`${t.url}/api/checks/${check.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: pending.revision }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "manual_application_required", target_path: file });
  expect(write).not.toHaveBeenCalled(); write.mockRestore();
  if (bytes) expect(fs.readFileSync(file)).toEqual(bytes);
  expect(t.roots.store.getMcpCheckProposal(check.id)).toEqual(row);
  expect(t.roots.store.checkStats()[check.id]).toEqual(stats);
  expect(t.roots.store.db.prepare("SELECT * FROM meta WHERE key != 'search_index' ORDER BY key").all()).toEqual(meta);
  expect(t.roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(active);
});

it.each(["removed-project", "new-shadow"])("manual save rejects a stale %s destination without falling back to another file", async (mode) => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  const project = path.join(t.roots.home, "project"); t.roots.config.checkDirs.push(project);
  const check = { id: "manual-target", kind: "rule", rule: { type: "count", at_least: 3 } } as Check;
  const active = t.roots.checks.save(check, mode === "removed-project" ? { dir: project } : "user");
  const pending = t.roots.checks.proposeMcp({ ...check, title: "Proposed" }, null);
  const original = fs.readFileSync(active.path!);
  let shadow: string | undefined;
  if (mode === "removed-project") t.roots.config.checkDirs = [];
  else { fs.mkdirSync(project, { recursive: true }); shadow = path.join(project, `${check.id}.yaml`); fs.writeFileSync(shadow, `id: ${check.id}\nkind: rule\nrule: { type: count, at_least: 7 }\n`); }
  const shadowBytes = shadow ? fs.readFileSync(shadow) : undefined;
  const row = t.roots.store.getMcpCheckProposal(check.id), stats = t.roots.store.checkStats()[check.id];
  const response = await fetch(`${t.url}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml: `id: ${check.id}\nkind: rule\nrule: { type: count, at_least: 1 }\n`, dir: pending.target_dir, manual_target_path: pending.target_path }) });
  expect(response.status).toBe(mode === "removed-project" ? 400 : 409);
  expect(fs.readFileSync(active.path!)).toEqual(original);
  if (shadow) expect(fs.readFileSync(shadow)).toEqual(shadowBytes);
  expect(t.roots.store.getMcpCheckProposal(check.id)).toEqual(row);
  expect(t.roots.store.checkStats()[check.id]).toEqual(stats);
});

it("explicit manual save targets the reviewed shared project file and retains disabled history and pending proposal", async () => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  const dir = path.join(t.roots.home, "project"); t.roots.config.checkDirs.push(dir); fs.mkdirSync(dir);
  const file = path.join(dir, "shared.yaml");
  fs.writeFileSync(file, "id: manual-shared\nkind: rule\nrule: { type: count, at_least: 3 }\n---\nid: untouched\nkind: rule\nrule: { type: count, at_least: 7 }\n");
  const check = { id: "manual-shared", kind: "rule", rule: { type: "count", at_least: 1 } } as Check;
  const p = t.roots.checks.proposeMcp(check, null);
  t.roots.store.db.prepare("UPDATE checks SET hits=9,dismissed=2,confirmed=1,enabled=0 WHERE id=?").run(check.id);
  const before = t.roots.store.checkStats()[check.id];
  const response = await fetch(`${t.url}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check, dir: p.target_dir, manual_target_path: p.target_path }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ path: file, source: "project" });
  expect(t.roots.checks.get("untouched")?.check).toMatchObject({ rule: { at_least: 7 } });
  expect(t.roots.checks.get(check.id)?.check).toMatchObject({ rule: { at_least: 1 } });
  expect(t.roots.store.checkStats()[check.id]).toEqual(before);
  expect(t.roots.checks.pendingMcpCheck(check.id)?.revision).toBe(p.revision);
  expect(t.roots.checks.isApprovedMcp(check.id)).toBe(false);
});

it.each([0, {}, null, ""])("malformed manual directory %j is rejected before writes", async (dir) => {
  const t = await makeRoots({ serve: true, noEngine: true }); cleanup.push(t.close);
  const check = { id: "malformed-manual", kind: "rule", rule: { type: "count", at_least: 3 } } as Check;
  const saved = t.roots.checks.save(check, "user"), bytes = fs.readFileSync(saved.path!);
  const write = vi.spyOn(fs, "writeFileSync");
  const response = await fetch(`${t.url}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check, dir, manual_target_path: saved.path }) });
  expect(response.status).toBe(400); expect(write).not.toHaveBeenCalled(); write.mockRestore();
  expect(fs.readFileSync(saved.path!)).toEqual(bytes);
});
