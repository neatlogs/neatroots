import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AuditArchive } from "../src/audit/archive.js";
import * as manifest from "../src/audit/manifest.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });
async function setup() {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; c.projects.exempt = { audit: false }; } });
  // Exercise real store/archives synchronously, independently of engine readiness.
  vi.spyOn(t.roots.audit as any, "reason").mockReturnValue(undefined);
  return t.roots;
}
function seed(count: number, project = "covered", payload = "small") {
  const ids = Array.from({ length: count }, () => hex(16));
  t.roots.store.ingest(ids.map(traceId => batch([span({ traceId, name: "root", kind: "workflow", attrs: [s("payload", payload)] })], project)));
  return ids;
}
function corrupt(id: string) {
  const directory = t.roots.audit.directory();
  new AuditArchive(t.roots).ensureMany([id], directory);
  const entry = manifest.verifyArchive(directory).entries[0];
  const file = path.join(directory, entry.path);
  const bytes = fs.readFileSync(file);
  fs.appendFileSync(file, "corruption");
  return () => fs.writeFileSync(file, bytes);
}

it.each(["age", "size", "both"] as const)("bounds archive failure work across many %s candidates and retries the next sweep", async mode => {
  const roots = await setup();
  const ids = seed(40);
  const exempt = seed(1, "exempt")[0];
  const doctor = hex(16), noProject = hex(16);
  const probe = batch([span({ traceId: doctor, name: "probe", kind: "workflow" })]);
  probe.resource.attributes.push(s("neatlogs.doctor", true));
  roots.store.ingest([probe, { resource: { attributes: [] }, scope: { attributes: [] }, spans: [span({ traceId: noProject, name: "none", kind: "workflow" })] }]);
  roots.store.db.prepare("UPDATE runs SET ended_ms=?").run(Date.now() - 30 * 86400000);
  const repair = corrupt(ids[0]);
  const check = vi.spyOn(manifest, "verifyArchive");
  const ensure = vi.spyOn(AuditArchive.prototype, "ensure");
  const days = mode === "size" ? 0 : 1, cap = mode === "age" ? Infinity : 1;
  expect(roots.store.sweep(days, cap)).toBe(3);
  expect(check).toHaveBeenCalledTimes(1);
  expect(ensure).toHaveBeenCalledTimes(1);
  for (const id of ids) expect(roots.store.getRun(id)).toBeDefined();
  for (const id of [exempt, doctor, noProject]) expect(roots.store.getRun(id)).toBeUndefined();
  expect(roots.audit.status().failures.map(f => f.trace_id).sort()).toEqual([...ids].sort());
  // Explicit deletion is a new attempt even after a negative sweep result.
  ensure.mockClear(); check.mockClear();
  expect(() => roots.store.deleteRun(ids[0])).toThrow(/audit hold/);
  expect(ensure).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
  repair();
  expect(roots.store.sweep(days, cap)).toBe(40);
  expect(manifest.verifyArchive(roots.audit.directory()).ok).toBe(true);
});

it("reuses an archive access failure without authorizing deletion and clears it after repair", async () => {
  const roots = await setup(); const ids = seed(20);
  roots.config.audit.directory = path.join(roots.home, "blocked");
  fs.writeFileSync(roots.config.audit.directory, "not a directory");
  const ensure = vi.spyOn(AuditArchive.prototype, "ensure");
  expect(roots.store.sweep(0, 1)).toBe(0);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(roots.config.audit.directory, "utf8")).toBe("not a directory");
  roots.config.audit.directory = "";
  expect(roots.store.sweep(0, 1)).toBe(ids.length);
});

it("keeps a missing run payload local so a healthy candidate is archived and deleted", async () => {
  const roots = await setup();
  const [bad] = seed(1, "covered", "missing".repeat(100000));
  const [good] = seed(1);
  roots.store.db.prepare("UPDATE runs SET ended_ms=?").run(Date.now() - 30 * 86400000);
  const row = roots.store.db.prepare("SELECT blobs FROM spans WHERE trace_id=?").get(bad) as { blobs: string };
  const sha = JSON.parse(row.blobs)[0];
  const get = roots.store.blobs.get.bind(roots.store.blobs);
  vi.spyOn(roots.store.blobs, "get").mockImplementation(value => value === sha ? undefined : get(value));
  expect(roots.store.sweep(1, Infinity)).toBe(1);
  expect(roots.store.getRun(bad)).toBeDefined();
  expect(roots.store.getRun(good)).toBeUndefined();
  expect(manifest.verifyArchive(roots.audit.directory()).entries.map(e => e.trace_id)).toEqual([good]);
});

it("reverifies at final deletion and clears the sweep failure on an exceptional exit", async () => {
  const roots = await setup(); const [id] = seed(1);
  roots.store.db.prepare("UPDATE runs SET ended_ms=?").run(Date.now() - 30 * 86400000);
  const original = AuditArchive.prototype.ensure;
  let repair = () => {};
  const ensure = vi.spyOn(AuditArchive.prototype, "ensure").mockImplementation(function (this: AuditArchive, traceId, directory) {
    const result = original.call(this, traceId, directory);
    const file = path.join(directory, result.path); const bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "late corruption"); repair = () => fs.writeFileSync(file, bytes);
    return result;
  });
  expect(() => roots.store.sweep(1, Infinity)).toThrow(/audit hold/);
  expect(ensure).toHaveBeenCalledTimes(2); // selection succeeded; final fresh check failed
  expect(roots.store.getRun(id)).toBeDefined();
  ensure.mockRestore(); repair();
  expect(roots.store.sweep(1, Infinity)).toBe(1);
  expect(roots.store.getRun(id)).toBeUndefined();
});
