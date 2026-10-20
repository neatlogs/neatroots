import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { Store } from "../src/store/db.js";
import { AuditArchive } from "../src/audit/archive.js";
import * as manifest from "../src/audit/manifest.js";
import { AuditCoverage } from "../src/audit/coverage.js";
import { batch, hex, makeRoots, s, span, tmpHome, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; for (const f of cleanup.splice(0).reverse()) await f(); });

it("reads large status from metadata without verifying, serializing snapshots or hydrating payloads", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots;
  const batches = Array.from({ length: 240 }, (_, i) => batch([span({ traceId: hex(16), name: "PRIVATE", kind: "workflow", attrs: [s("payload", "x".repeat(5000))] })], i % 2 ? "unknown" : "named"));
  roots.store.ingest(batches);
  const archive = new AuditArchive(roots);
  archive.ensureMany(batches.slice(0, 32).map(b => b.spans[0].traceId), roots.audit.directory());
  const verify = vi.spyOn(manifest, "verifyArchive").mockImplementation(() => { throw new Error("must not verify"); });
  const hydrate = vi.spyOn(roots.store, "batchesForTraces").mockImplementation(() => { throw new Error("must not hydrate"); });
  const blobs = vi.spyOn(roots.store.blobs, "get").mockImplementation(() => { throw new Error("must not read payload"); });
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("must not read archive files"); });
  const state = roots.audit.status();
  read.mockRestore();
  expect(state.covered_runs).toBe(240);
  expect(state.held_bytes).toBeGreaterThan(0);
  expect(state.verified).not.toBe(true);
  expect((state as any).observed_ms).toBeGreaterThan(0);
  expect(JSON.stringify(state)).not.toContain("PRIVATE");
  expect(verify).not.toHaveBeenCalled(); expect(hydrate).not.toHaveBeenCalled(); expect(blobs).not.toHaveBeenCalled();
});

it("labels unknown/current/stale/error observations conservatively and never authorizes corrupt deletion", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots;
  vi.spyOn(roots.audit as any, "reason").mockReturnValue(undefined);
  const id = hex(16); roots.store.ingest([batch([span({ traceId: id, name: "original", kind: "workflow" })])]);
  expect((roots.audit.status() as any).observation_state).toBe("unknown");
  roots.audit.beforeDelete(id);
  expect((roots.audit.status() as any).last_observed_verified).toBe(true);
  expect((roots.audit.status() as any).observation_state).toBe("current");
  expect(roots.audit.status().verified).not.toBe(true);
  roots.store.insertAnnotation({ trace_id: id, span_id: null, label: "changed", text: "PRIVATE", author: "test" });
  expect((roots.audit.status() as any).observation_state).toBe("stale");
  roots.audit.beforeDelete(id);
  roots.store.insertFinding({ trace_id: id, check_id: "test", check_kind: "rule", title: "changed", probability: 1,
    status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  expect((roots.audit.status() as any).observation_state).toBe("stale");
  roots.audit.beforeDelete(id);
  const manifestFile = path.join(roots.audit.directory(), "manifest.jsonl");
  fs.utimesSync(manifestFile, new Date(), new Date(Date.now() + 1000));
  expect((roots.audit.status() as any).observation_state).toBe("stale");
  roots.audit.beforeDelete(id);
  const entry = manifest.verifyArchive(roots.audit.directory()).entries.at(-1)!;
  fs.appendFileSync(path.join(roots.audit.directory(), entry.path), "tampered");
  expect(roots.audit.status().verified).not.toBe(true);
  expect(() => roots.store.deleteRun(id)).toThrow(/audit hold/);
  expect(roots.audit.status()).toMatchObject({ observation_state: "error", archive_totals_known: true, archive_entries: 3 });
  roots.config.audit.directory = path.join(roots.home, "different");
  expect((roots.audit.status() as any).observation_state).toBe("unknown");
  roots.config.audit.enabled = false;
  expect(roots.audit.status().covered_runs).toBe(0);
});

it("guards an actual pre-metadata store across late completion and restart without trusting sender markers", async () => {
  const home = tmpHome(); cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const old = new Store(path.join(home, "data"));
  const oldId = hex(16), oldLive = hex(16);
  const original = batch([span({ traceId: oldId, parent: hex(8), name: "old import", kind: "tool" })]);
  original.resource.attributes.push(s("neatroots.import.source", "file"));
  old.ingest([original, batch([span({ traceId: oldLive, parent: hex(8), name: "old unknown", kind: "tool" })])]);
  // Recreate the schema state before local provenance tracking was introduced.
  old.db.prepare("DELETE FROM meta WHERE key='import-provenance-cutover-v1'").run();
  old.db.exec("DROP TABLE IF EXISTS import_provenance_unknown"); old.close();
  t = await makeRoots({ noEngine: true }); const config = t.roots.config; config.projects["test-agent"] = { forward: true };
  let roots = new Roots({ home, config, noEngine: true }); cleanup.push(() => roots.close());
  const forward = () => vi.spyOn(roots.relay, "forward").mockResolvedValue({ id: "mock", trace_ids: [], endpoint: "http://127.0.0.1", status: "ok", http_status: 200, span_count: 0, bytes: 0, redactions: 0, error: null, initiated_by: "auto", created_ms: 0 });
  let sent = forward();
  const complete = (id: string) => roots.ingest([batch([span({ traceId: id, name: "ended", kind: "workflow" })])]);
  complete(oldId); complete(oldLive);
  await new Promise(r => setTimeout(r, 1800)); expect(sent).not.toHaveBeenCalled();
  expect(new AuditCoverage(roots, () => []).status()).toMatchObject({ imported_runs: 0, unclassified_runs: 2 });
  roots.close(); roots = new Roots({ home, config, noEngine: true }); sent = forward();
  roots.store.deleteRun(oldId); // A delayed redelivery must retain the historical privacy guard.
  complete(oldId); const live = hex(16); complete(live);
  roots.ingest([batch([span({ traceId: hex(16), name: "new import", kind: "workflow" })])], { importSource: "file" });
  await new Promise(r => setTimeout(r, 1800)); expect(sent).toHaveBeenCalledExactlyOnceWith([live], "auto");
  expect(new AuditCoverage(roots, () => []).status()).toMatchObject({ traced_runs: 1, imported_runs: 1, unclassified_runs: 2 });
});

it("restarts with unknown observations and preserves no-project versus literal unknown coverage", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots, named = hex(16), absent = hex(16);
  roots.store.ingest([batch([span({ traceId: named, name: "named", kind: "workflow" })], "unknown"),
    { resource: { attributes: [] }, scope: { attributes: [] }, spans: [span({ traceId: absent, name: "absent", kind: "workflow" })] }]);
  new AuditArchive(roots).ensureMany([named], roots.audit.directory());
  expect(roots.audit.status().covered_runs).toBe(1);
  roots.close();
  const reopened = new Roots({ home: roots.home, config: roots.config, noEngine: true });
  cleanup.push(() => reopened.close());
  expect(reopened.audit.status()).toMatchObject({ covered_runs: 1, held_runs: 1, observation_state: "unknown", observed_ms: null, archive_totals_known: false });
});


it("does not invent archive totals when the first post-write verification fails", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const roots = t.roots, id = hex(16);
  roots.store.ingest([batch([span({ traceId: id, name: "original", kind: "workflow" })])]);
  const write = fs.writeFileSync;
  const tamper = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, data: any, ...args: any[]) => {
    const result = (write as any)(file, data, ...args);
    if (typeof file === "number" && Buffer.isBuffer(data) && data.toString().includes('"seq":1')) {
      const entry = JSON.parse(data.toString());
      fs.appendFileSync(path.join(roots.audit.directory(), entry.path), "tampered after append");
    }
    return result;
  }) as typeof fs.writeFileSync);
  expect(() => new AuditArchive(roots).export(id)).toThrow(/post-write verification/);
  tamper.mockRestore();
  expect(roots.audit.status()).toMatchObject({ observation_state: "error", last_observed_verified: false, archive_totals_known: false });
});

it("holds observed snapshots during real engine end and recheck work without a progress row", async () => {
  t = await makeRoots({ config: c => { c.audit.enabled = true; } });
  const roots = t.roots, engine = roots.engine!, id = hex(16);
  vi.spyOn(roots.llm, "isAvailable").mockResolvedValue(false);
  vi.spyOn(roots.decisions, "decide").mockImplementation(async (_state, questions) => ({
    answers: Object.fromEntries(questions.map(q => [q.name, { name: q.name, type: q.type, probability: 0, distribution: {}, score: 0 }])),
    backend: "local-test", model: "local-test", latencyMs: 0,
  }));
  const telemetry = [batch([span({ traceId: id, name: "ended", kind: "workflow" })])];
  const unfinished = structuredClone(telemetry);
  unfinished[0].spans[0].endTimeUnixNano = "0";
  roots.store.ingest(unfinished);
  roots.ingest(telemetry); // An existing root ends without creating a fresh-span job.
  new AuditArchive(roots).ensure(id, roots.audit.directory());
  expect(engine.progress.state(id)).toBeUndefined();
  expect(roots.audit.status().hold_reasons["checks are pending or interrupted"]).toBe(1);
  await vi.waitFor(() => expect(engine.auditReady(id)).toBe(true));
  new AuditArchive(roots).ensure(id, roots.audit.directory());
  expect(roots.audit.status().archived_live_runs).toBe(1);
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const work = vi.spyOn(engine as any, "recheckWork").mockReturnValue(blocked);
  const recheck = engine.recheck(id);
  expect(engine.progress.state(id)).toBeUndefined();
  expect(roots.audit.status().hold_reasons["checks are pending or interrupted"]).toBe(1);
  finish(); await recheck; work.mockRestore();
  expect(roots.audit.status().archived_live_runs).toBe(1);
});
