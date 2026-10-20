import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AuditCoverage, CONNECTION_NOTICE } from "../src/audit/coverage.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });
const add = (project = "shop", source?: string) => {
  const id = hex(16);
  const b = batch([span({ traceId: id, name: "PRIVATE-SPAN-PAYLOAD", kind: "workflow" })], project);
  b.resource.attributes.push(s("neatroots.import.source", "forged-private-source"));
  t.roots.ingest([b], source ? { importSource: source } : {});
  return id;
};

it("counts disjoint retained categories, trusted provenance and overlapping delivered guidance without payload hydration", async () => {
  t = await makeRoots({ noEngine: true });
  const received = add(), imported = add("shop", "private-registered-source"), unknown = add();
  t.roots.store.db.prepare("DELETE FROM spans WHERE trace_id = ?").run(unknown);
  const malformed = add(); t.roots.store.setMeta(`import-source:${malformed}`, "");
  const doctor = hex(16), probe = batch([span({ traceId: doctor, name: "probe", kind: "workflow" })]);
  probe.resource.attributes.push(s("neatlogs.doctor", true)); t.roots.ingest([probe]);
  for (const id of [received, received, imported, doctor]) {
    const note = t.roots.store.insertNote({ trace_id: id, finding_id: null, kind: "llm", text: "PRIVATE-NOTE", status: "pending", checks: null });
    t.roots.store.updateNote(note.id, { delivered_ms: Date.now(), status: "delivered" });
  }
  vi.spyOn(t.roots.store, "batchesForTraces").mockImplementation(() => { throw new Error("must not hydrate"); });
  const c = new AuditCoverage(t.roots, () => []).status();
  expect(c).toMatchObject({ observed_runs: 4, traced_runs: 1, imported_runs: 1, unclassified_runs: 2, guidance_delivered_runs: 2 });
  expect(c.projects[0]).toMatchObject({ project: "shop", traced: 1, imported: 1, unclassified: 2, guidance_delivered: 2 });
  expect(JSON.stringify(c)).not.toMatch(/PRIVATE|private-registered|forged-private/);
  t.roots.store.deleteRun(imported);
  expect(new AuditCoverage(t.roots, () => []).status()).toMatchObject({ observed_runs: 3, imported_runs: 0, guidance_delivered_runs: 1 });
});

it("reports absent projects and own-property audit inheritance without creating capture for configured projects", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; c.projects.off = { audit: false }; } });
  t.roots.config.projects.inherited = Object.create({ audit: false });
  add("unknown");
  const id = hex(16);
  t.roots.ingest([{ resource: { attributes: [] }, scope: { attributes: [] }, spans: [span({ traceId: id, name: "none", kind: "workflow" })] }]);
  const c = new AuditCoverage(t.roots, () => []).status();
  expect(c.observed_runs).toBe(2);
  expect(c.projects.find(p => p.project === null)).toMatchObject({ traced: 1, audit_enabled: false, audit_override: null });
  expect(c.projects.find(p => p.project === "unknown")).toMatchObject({ traced: 1, audit_enabled: true });
  expect(c.projects.find(p => p.project === "off")).toMatchObject({ traced: 0, audit_enabled: false, audit_override: false });
  expect(c.projects.find(p => p.project === "inherited")).toMatchObject({ audit_enabled: true, audit_override: null });
});

it("uses decoded last project values for null, empty and duplicate attributes", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const literal = add("unknown");
  const absent: string[] = [];
  const attributes = [
    [{ key: "service.name", value: {} }],
    [{ key: "neatlogs.workflow_name", value: {} }],
    [{ key: "neatlogs.workflow.name", value: { stringValue: "" } }],
    [s("service.name", "unknown"), { key: "service.name", value: {} }],
    [s("neatlogs.workflow_name", "unknown"), { key: "neatlogs.workflow_name", value: {} }],
  ];
  for (const attrs of attributes) {
    const traceId = hex(16); absent.push(traceId);
    t.roots.ingest([{ resource: { attributes: attrs }, scope: { attributes: [] }, spans: [span({ traceId, name: "private", kind: "workflow" })] }]);
  }
  const before = t.roots.store.db.prepare("SELECT json FROM resources ORDER BY id").all();
  vi.spyOn(t.roots.store.blobs, "get").mockImplementation(() => { throw new Error("must not hydrate"); });
  const c = new AuditCoverage(t.roots, () => []).status();
  expect(c.projects.find(p => p.project === null)).toMatchObject({ traced: 5, audit_enabled: false });
  expect(c.projects.find(p => p.project === "unknown")).toMatchObject({ traced: 1, audit_enabled: true });
  expect(t.roots.store.db.prepare("SELECT json FROM resources ORDER BY id").all()).toEqual(before);
  // The bounded scheduler deliberately over-selects fallback unknown rows cheaply;
  // deferred exact coverage must agree with the coverage view before archiving.
  const hold = t.roots.audit as any;
  for (const id of [literal, ...absent]) {
    const run = t.roots.store.getRun(id)!;
    expect(hold.candidate(run)).toBe(true);
    expect(t.roots.audit.covered(run)).toBe(id === literal);
  }
});

it("caches bounded discovery, returns safe projections, and keeps counts when discovery fails", async () => {
  t = await makeRoots({ noEngine: true }); add();
  let now = 1000;
  const discover = vi.fn(() => [{ id: "cursor", label: "Cursor", detected: true, connected: true, where: "PRIVATE-PATH", note: "PRIVATE-COMMAND" }]);
  const coverage = new AuditCoverage(t.roots, discover, () => now);
  expect(coverage.status().connections.clients[0]).toEqual({ id: "cursor", label: "Cursor", detected: true, connected: true, capture: "not_established" });
  expect(coverage.status().connection_notice).toBe(CONNECTION_NOTICE);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(coverage.status())).not.toContain("PRIVATE");
  now += 30001; discover.mockImplementation(() => { throw new Error("PRIVATE-ERROR"); });
  expect(coverage.status()).toMatchObject({ observed_runs: 1, connections: { state: "unavailable", clients: [] } });
  coverage.status(); expect(discover).toHaveBeenCalledTimes(2);
});

it("adds coverage to the audit status API without changing its retention fields", async () => {
  t = await makeRoots({ noEngine: true, serve: true }); add();
  const response = await fetch(`${t.url}/api/audit/status`);
  const data = await response.json();
  expect(data).toMatchObject({ covered_runs: 0, held_runs: 0, archive_entries: 0, coverage: { observed_runs: 1, traced_runs: 1 } });
  expect(JSON.stringify(data.coverage)).not.toContain("PRIVATE");
  const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve(import.meta.dirname, "../src/cli.ts"), "audit", "status", "--port", String(t.roots.config.port)], { env: { ...process.env, NEATROOTS_HOME: t.roots.home }, timeout: 10000 });
  expect(JSON.parse(result.stdout).coverage.observed_runs).toBe(data.coverage.observed_runs);
  expect(result.stdout).not.toContain("PRIVATE");
});
