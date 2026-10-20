import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig, projectSettings } from "../src/config.js";
import { snapshot } from "../src/audit/archive.js";
import { readFile } from "../src/audit/files.js";
import { verifyArchive } from "../src/audit/manifest.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });
const setup = async (noEngine = false) => t = await makeRoots({ noEngine, serve: true, config: c => { c.audit.enabled = true; } });
const ingest = (project = "covered", ended = true) => {
  const traceId = hex(16);
  const root = span({ traceId, parent: ended ? undefined : hex(8), name: "sensitive original", kind: "workflow" });
  t.roots.ingest([batch([root], project)]);
  return traceId;
};
const idle = (id: string) => until(() => t.roots.engine?.auditReady(id));
const verify = () => verifyArchive(t.roots.audit.directory());
const remove = (id: string) => fetch(`${t.url}/api/runs/${id}`, { method: "DELETE" });
const settings = (body: object) => fetch(`${t.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("audit archive before release", () => {
  it("is off by default, inherits globally and supports project opt-in and opt-out", async () => {
    const config = defaultConfig();
    expect(projectSettings(config, "one").audit).toBe(false);
    config.projects.one = { audit: true };
    expect(projectSettings(config, "one").audit).toBe(true);
    config.audit.enabled = true;
    config.projects.two = { audit: false };
    expect(projectSettings(config, "two").audit).toBe(false);
    await setup(true);
    t.roots.config.audit.enabled = false;
    const disabled = ingest();
    expect((await remove(disabled)).status).toBe(200);
    t.roots.config.audit.enabled = true;
    t.roots.config.projects.exempt = { audit: false };
    expect((await remove(ingest("exempt"))).status).toBe(200);
    t.roots.config.audit.enabled = false;
    t.roots.config.projects.covered = { audit: true };
    expect((await remove(ingest())).status).toBe(409);
    expect(fs.existsSync(t.roots.audit.directory())).toBe(false);
  });

  it("exempts doctor probes and runs with no project even without an engine", async () => {
    await setup(true);
    const doctor = hex(16), noProject = hex(16);
    const probe = batch([span({ traceId: doctor, name: "doctor", kind: "workflow" })]);
    probe.resource.attributes.push(s("neatlogs.doctor", true));
    t.roots.ingest([probe, { resource: { attributes: [] }, scope: { attributes: [] }, spans: [span({ traceId: noProject, name: "none", kind: "workflow" })] }]);
    expect((await remove(doctor)).status).toBe(200);
    expect((await remove(noProject)).status).toBe(200);
    expect(t.roots.audit.status().covered_runs).toBe(0);
    expect((await remove(ingest("unknown"))).status).toBe(409);
  });

  it("holds ongoing, delayed end, no-engine and interrupted check work", async () => {
    await setup();
    const running = ingest("covered", false), ended = ingest();
    expect((await remove(running)).status).toBe(409);
    expect((await remove(ended)).status).toBe(409);
    await idle(ended);
    t.roots.engine!.progress.interrupted(ended);
    expect((await remove(ended)).status).toBe(409);
    t.roots.engine!.progress.done(ended);
    const pending = vi.spyOn(t.roots.engine!, "pending").mockReturnValue(1);
    expect((await remove(ended)).status).toBe(409);
    pending.mockRestore();
    expect((await remove(ended)).status).toBe(200);
  });

  it("holds persisted unfinished work immediately after restart before recovery begins", async () => {
    t = await makeRoots({ config: c => { c.audit.enabled = true; } });
    const id = ingest(); await idle(id);
    t.roots.engine!.progress.checking(id);
    const home = t.roots.home, config = t.roots.config;
    t.roots.close();
    t.roots = new Roots({ home, config });
    t.close = async () => { t.roots.close(); fs.rmSync(home, { recursive: true, force: true }); };
    expect(t.roots.engine!.pending(id)).toBe(0);
    expect(() => t.roots.store.deleteRun(id)).toThrow(/checks are pending or interrupted/);
    expect(t.roots.store.sweep(0, 1)).toBe(0);
    expect(t.roots.store.getRun(id)).toBeDefined();
    await until(() => t.roots.engine!.auditReady(id));
    expect(() => t.roots.store.deleteRun(id)).not.toThrow();
  });

  it("holds on-demand explanation work but archives settled failed checks", async () => {
    await setup();
    const id = ingest(); await idle(id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chat = vi.spyOn(t.roots.llm, "chat").mockImplementation(async () => { await gate; return { json: {} } as any; });
    const work = t.roots.engine!.explainRun(id, { force: true });
    expect((await remove(id)).status).toBe(409);
    release(); await work; chat.mockRestore();
    await (t.roots.engine as any).track(id, Promise.reject(new Error("test failure")));
    expect(t.roots.engine!.auditReady(id)).toBe(true);
    expect((await remove(id)).status).toBe(200);
  });

  it("archives automatically, deduplicates unchanged bytes, and appends late spans and findings", async () => {
    await setup();
    const id = ingest();
    await until(() => fs.existsSync(path.join(t.roots.audit.directory(), "manifest.jsonl")));
    await idle(id);
    expect(verify().entries).toHaveLength(1);
    const first = verify().entries[0];
    const original = readFile(path.join(t.roots.audit.directory(), first.path));
    t.roots.audit.beforeDelete(id);
    t.roots.audit.beforeDelete(id);
    expect(verify().entries).toHaveLength(1);
    const rootId = t.roots.store.getRun(id)!.root_span_id!;
    t.roots.ingest([batch([span({ traceId: id, parent: rootId, name: "late", kind: "tool" })], "covered")]);
    await idle(id);
    t.roots.audit.beforeDelete(id);
    expect(verify().entries).toHaveLength(2);
    const finding = t.roots.store.insertFinding({ trace_id: id, check_id: "late-audit", check_kind: "rule",
      title: "late finding", probability: 1, status: "raised", evidence_span_ids: [rootId],
      detail: {}, model: null, triage_score: null, explanation_id: null });
    t.roots.bus.emit("finding", finding);
    t.roots.audit.beforeDelete(id);
    expect(verify().entries).toHaveLength(3);
    expect(readFile(path.join(t.roots.audit.directory(), first.path))).toEqual(original);
    const latest = verify().entries.at(-1)!;
    expect(readFile(path.join(t.roots.audit.directory(), latest.path))).toEqual(snapshot(t.roots, id).trace);
    const sidecar = JSON.parse(readFile(path.join(t.roots.audit.directory(), path.dirname(latest.path), "record.json")).toString());
    expect(sidecar.findings.some((f: { id: string }) => f.id === finding.id)).toBe(true);
  });

  it("archives only committed imported replacements and keeps the previous archive on rollback", async () => {
    await setup();
    const id = hex(16);
    const source = batch([span({ traceId: id, name: "imported", kind: "workflow",
      attrs: [s("payload", "old".repeat(100000)), s("neatroots.import.source", "untrusted")] })], "covered");
    t.roots.ingest([source], { importSource: "registry" });
    await idle(id);
    t.roots.audit.beforeDelete(id);
    const first = verify().entries[0];
    const original = snapshot(t.roots, id);
    const replacement = structuredClone(source);
    replacement.spans[0].attributes[0] = s("payload", "new".repeat(100000));
    const failure = vi.spyOn(t.roots.store, "setMeta").mockImplementationOnce(() => { throw new Error("provenance failed"); });
    expect(() => t.roots.ingest([replacement], { importSource: "file" })).toThrow("provenance failed");
    failure.mockRestore();
    expect(snapshot(t.roots, id)).toEqual(original);
    t.roots.audit.beforeDelete(id);
    expect(verify().entries).toHaveLength(1);
    t.roots.ingest([replacement], { importSource: "file" });
    await idle(id);
    expect((await remove(id)).status).toBe(200);
    const entries = verify().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(first);
    const latest = entries[1];
    const sidecar = JSON.parse(readFile(path.join(t.roots.audit.directory(), path.dirname(latest.path), "record.json")).toString());
    expect(sidecar.import_source).toBe("file");
    expect(readFile(path.join(t.roots.audit.directory(), latest.path)).toString()).toContain("new".repeat(100000));
    expect(readFile(path.join(t.roots.audit.directory(), first.path))).toEqual(original.trace);
  });

  it("refuses explicit deletion on write or verification failure, then archives before deleting", async () => {
    await setup();
    const id = ingest(); await idle(id);
    const file = path.join(t.roots.home, "not-a-directory"); fs.writeFileSync(file, "unrelated");
    t.roots.config.audit.directory = file;
    expect((await remove(id)).status).toBe(409);
    expect(t.roots.store.getRun(id)).toBeDefined();
    expect(t.roots.audit.status().failures).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe("unrelated");
    t.roots.config.audit.directory = "";
    t.roots.audit.beforeDelete(id);
    const entry = verify().entries[0];
    if (process.platform !== "win32") {
      fs.chmodSync(t.roots.audit.directory(), 0o755);
      expect((await remove(id)).status).toBe(409);
      expect(t.roots.audit.status()).toMatchObject({ held_runs: 1, archived_live_runs: 0 });
      fs.chmodSync(t.roots.audit.directory(), 0o700);
      t.roots.audit.beforeDelete(id);
      expect(t.roots.audit.status().archived_live_runs).toBe(1);
    }
    fs.appendFileSync(path.join(t.roots.audit.directory(), entry.path), "tamper");
    expect((await remove(id)).status).toBe(409);
    fs.writeFileSync(path.join(t.roots.audit.directory(), entry.path), snapshot(t.roots, id).trace);
    t.roots.focus = { trace_id: id, span_id: null, at: Date.now() };
    expect((await remove(id)).status).toBe(200);
    expect(t.roots.store.getRun(id)).toBeUndefined();
    expect(t.roots.focus).toBeNull();
    expect(verify().ok).toBe(true);
    expect(t.roots.audit.status()).toMatchObject({ covered_runs: 0, archived_runs: 1, archive_entries: 1 });
  });

  it("retention keeps failed and pinned runs, releasing age candidates only after verification", async () => {
    await setup();
    const id = ingest(), pinned = ingest(); await idle(id); await idle(pinned);
    t.roots.store.setPinned(pinned, true);
    t.roots.store.db.prepare("UPDATE runs SET ended_ms = ?").run(Date.now() - 30 * 86400000);
    t.roots.config.audit.directory = path.join(t.roots.home, "blocked"); fs.writeFileSync(t.roots.config.audit.directory, "blocked");
    expect(t.roots.store.sweep(14, Infinity)).toBe(0);
    expect(t.roots.store.getRun(id)).toBeDefined();
    t.roots.config.audit.directory = "";
    expect(t.roots.store.sweep(14, Infinity)).toBe(1);
    expect(t.roots.store.getRun(id)).toBeUndefined();
    expect(t.roots.store.getRun(pinned)).toBeDefined();
    expect(verify().ok).toBe(true);
  });

  it("size retention skips held bytes and selects later releasable runs", async () => {
    await setup();
    const held = ingest("covered", false), released = ingest(); await idle(released);
    const payload = "x".repeat(800000);
    const root = t.roots.store.getRun(released)!.root_span_id!;
    t.roots.ingest([batch([span({ traceId: released, parent: root, name: "large", kind: "tool", attrs: [s("neatlogs.tool.output", payload)] })], "covered")]);
    t.roots.ingest([batch([span({ traceId: held, parent: hex(8), name: "shared", kind: "tool", attrs: [s("neatlogs.tool.output", payload)] })], "covered")]);
    await idle(released);
    const other = ingest();
    t.roots.ingest([batch([span({ traceId: other, parent: t.roots.store.getRun(other)!.root_span_id!, name: "unique", kind: "tool", attrs: [s("neatlogs.tool.output", "y".repeat(900000))] })], "covered")]);
    await idle(other);
    const cap = t.roots.store.storedBytes() - 600000;
    expect(t.roots.store.sweep(0, cap)).toBe(2);
    expect(t.roots.store.getRun(other)).toBeUndefined();
    expect(t.roots.store.getRun(held)).toBeDefined();
    expect(t.roots.store.getRun(released)).toBeUndefined();
    expect(t.roots.audit.status().held_runs).toBe(1);
    expect(snapshot(t.roots, held).trace.toString()).toContain(payload);
    expect(t.roots.store.sweep(0, 1)).toBe(0);
    expect(t.roots.store.storedBytes()).toBeGreaterThan(1); // Held work remains counted, not silently discarded.
  });

  it("reaches the live size cap after archiving eligible candidates", async () => {
    await setup();
    const ids = Array.from({ length: 12 }, () => ingest());
    for (const id of ids) {
      t.roots.ingest([batch([span({ traceId: id, parent: t.roots.store.getRun(id)!.root_span_id!, name: "sized",
        kind: "tool", attrs: [s("neatlogs.tool.output", id.repeat(2000))] })], "covered")]);
    }
    await Promise.all(ids.map(idle));
    const cap = t.roots.store.storedBytes() * 0.75;
    expect(t.roots.store.sweep(0, cap)).toBeGreaterThan(0);
    t.roots.store.sweep(0, cap); // Compact deferred FTS deletions using the existing retention path.
    expect(t.roots.store.storedBytes()).toBeLessThanOrEqual(cap);
    expect(verify().ok).toBe(true);
  });

  it("counts exact live snapshot bytes, historical archive bytes and concurrent delete safely", async () => {
    await setup();
    const id = ingest(); await idle(id);
    const data = snapshot(t.roots, id), bytes = data.trace.length + data.record.length;
    expect(t.roots.audit.status()).toMatchObject({ covered_runs: 1, held_runs: 1, held_bytes: bytes });
    t.roots.audit.beforeDelete(id);
    const state = t.roots.audit.status();
    expect(state).toMatchObject({ archived_live_runs: 1, archived_live_bytes: bytes, held_bytes: 0 });
    expect(state.archive_bytes).toBeGreaterThan(bytes);
    const results = await Promise.all([remove(id), remove(id)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(verify().entries).toHaveLength(1);
  });

  it("rejects reserved project keys without mutation and ignores inherited audit flags", async () => {
    await setup(true);
    const id = ingest("ordinary", false);
    expect(Object.hasOwn(Object.prototype, "audit")).toBe(false);
    try {
      for (const project of ["__proto__", "constructor", "prototype"]) {
        for (const audit of [false, null]) {
          const response = await settings({ project, audit });
          expect((await remove(id)).status).toBe(409);
          expect(response.status).toBe(400);
          expect(Object.hasOwn(Object.prototype, "audit")).toBe(false);
          expect(t.roots.config.audit.enabled).toBe(true);
          expect(projectSettings(t.roots.config, "ordinary").audit).toBe(true);
        }
      }
      const inherited = { audit: false };
      t.roots.config.projects.inherited = Object.create(inherited);
      expect(projectSettings(t.roots.config, "inherited").audit).toBe(true);
      expect((await settings({ project: "inherited", audit: null })).status).toBe(200);
      expect(inherited.audit).toBe(false);
      expect(projectSettings(t.roots.config, "inherited").audit).toBe(true);
      expect((await settings({ project: "toString", audit: false })).status).toBe(200);
      expect(Object.hasOwn(t.roots.config.projects, "toString")).toBe(true);
      expect(projectSettings(t.roots.config, "toString").audit).toBe(false);
      expect(Object.hasOwn(Object.prototype.toString, "audit")).toBe(false);
      expect((await remove(id)).status).toBe(409);
    } finally {
      // A regression must not pollute later tests after its expected first assertion fails.
      delete (Object.prototype as { audit?: unknown }).audit;
    }
  });

  it("settings validate atomically, persist global config and support restoring project inheritance", async () => {
    await setup();
    expect((await settings({ audit_enabled: false, audit: "yes", project: "covered" })).status).toBe(400);
    expect(t.roots.config.audit.enabled).toBe(true);
    expect((await settings({ audit_directory: "../bad", audit_enabled: false })).status).toBe(400);
    expect((await settings({ audit_enabled: false, project: "covered", audit: true })).status).toBe(200);
    expect(projectSettings(t.roots.config, "covered").audit).toBe(true);
    expect((await settings({ project: "covered", audit: null })).status).toBe(200);
    expect(projectSettings(t.roots.config, "covered").audit).toBe(false);
    const status = await (await fetch(`${t.url}/api/audit/status`)).json();
    expect(status.enabled).toBe(false);
    expect(JSON.stringify(status)).not.toContain("sensitive original");
    expect(fs.readFileSync(path.join(t.roots.home, "config.yaml"), "utf8")).toContain("audit:");
  });
});
