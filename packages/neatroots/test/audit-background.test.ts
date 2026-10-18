import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditArchive } from "../src/audit/archive.js";
import * as manifest from "../src/audit/manifest.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

let tb: TestRoots;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await tb?.close(); });
async function setup() {
  tb = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  // Scheduling tests isolate readiness; deletion tests still use the real beforeDelete method.
  vi.spyOn(tb.roots.audit as any, "reason").mockReturnValue(undefined);
  return tb.roots;
}
function seed(count = 1, project = "covered") {
  const ids = Array.from({ length: count }, () => hex(16));
  tb.roots.store.ingest(ids.map(traceId => batch([span({ traceId, name: "root", kind: "workflow", attrs: [s("payload", "x".repeat(1000))] })], project)));
  return ids;
}
const archive = () => new AuditArchive(tb.roots);
const directory = () => tb.roots.audit.directory();
const verify = () => manifest.verifyArchive(directory());

// Counts are algorithmic bounds, not hardware-dependent timing assertions.
describe("bounded audit background work", () => {
  it("verifies once for an unchanged page, twice for changed pages, and retains old versions", async () => {
    await setup();
    const ids = seed(32);
    const check = vi.spyOn(manifest, "verifyArchive");
    const payloads = vi.spyOn(tb.roots.store, "batchesForTraces");
    expect(archive().ensureMany(ids, directory()).archived).toEqual(ids);
    expect(check).toHaveBeenCalledTimes(2);
    expect(payloads).toHaveBeenCalledTimes(32);
    const first = verify().entries[0];
    const bytes = fs.readFileSync(path.join(directory(), first.path));
    check.mockClear(); payloads.mockClear();
    archive().ensureMany(ids, directory());
    expect(check).toHaveBeenCalledTimes(1);
    expect(payloads).toHaveBeenCalledTimes(32);
    tb.roots.store.db.prepare("UPDATE runs SET termination_reason = 'changed' WHERE trace_id = ?").run(ids[0]);
    check.mockClear();
    archive().ensureMany(ids, directory());
    expect(check).toHaveBeenCalledTimes(2);
    expect(verify().entries).toHaveLength(33);
    expect(fs.readFileSync(path.join(directory(), first.path))).toEqual(bytes);
  });

  it("coalesces events without hydrating unknown projects or postponing the drain", async () => {
    await setup();
    const ids = seed(65, "unknown");
    vi.useFakeTimers();
    const payloads = vi.spyOn(tb.roots.store, "batchesForTraces");
    const schedule = (tb.roots.audit as any).schedule.bind(tb.roots.audit);
    for (const id of ids) { schedule(id); schedule(id); }
    expect(payloads).not.toHaveBeenCalled();
    const publish = vi.spyOn(AuditArchive.prototype, "ensureMany").mockReturnValue({ archived: [], failed: [] });
    await vi.advanceTimersByTimeAsync(1000);
    schedule(ids[0]);
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toHaveLength(32);
    expect(payloads).toHaveBeenCalledTimes(32); // exact coverage, only at drain
    await vi.advanceTimersByTimeAsync(3000);
    expect(publish.mock.calls.map(c => c[0].length)).toEqual([32, 32, 1]);
  });

  it("pages periodically and reserves room for no-event changes under event traffic", async () => {
    await setup();
    const ids = seed(65).sort();
    vi.useFakeTimers();
    const publish = vi.spyOn(AuditArchive.prototype, "ensureMany").mockReturnValue({ archived: [], failed: [] });
    const hold = tb.roots.audit as any;
    hold.scheduleAll();
    for (const id of ids.slice(32)) hold.schedule(id);
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish.mock.calls[0][0].slice(0, 16)).toEqual(ids.slice(0, 16));
    await vi.advanceTimersByTimeAsync(3000);
    publish.mockClear();
    hold.scheduleAll();
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish.mock.calls[0][0]).toEqual(ids.slice(32, 64));
    hold.scheduleAll();
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish.mock.calls[1][0]).toEqual(ids.slice(64));
    // Wrap revisits a manually changed row without any bus event.
    tb.roots.store.insertAnnotation({ trace_id: ids[0], span_id: null, label: "note", text: "manual annotation", author: "test" });
    publish.mockRestore();
    hold.scheduleAll();
    await vi.advanceTimersByTimeAsync(1500);
    const entry = verify().entries.find(e => e.trace_id === ids[0])!;
    expect(fs.readFileSync(path.join(directory(), path.dirname(entry.path), "record.json"), "utf8")).toContain("manual annotation");
  });

  it("forgets queued IDs, rechecks readiness and settings, and stops on close", async () => {
    const roots = await setup(); const ids = seed(3);
    vi.useFakeTimers();
    const publish = vi.spyOn(AuditArchive.prototype, "ensureMany").mockReturnValue({ archived: [], failed: [] });
    const hold = roots.audit as any;
    for (const id of ids) hold.schedule(id);
    hold.forgotten([ids[0]]);
    roots.config.projects.covered = { audit: false };
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish.mock.calls[0][0]).toEqual([]);
    roots.config.projects.covered = { audit: true };
    hold.scheduleAll();
    vi.mocked(hold.reason).mockReturnValue("checks pending");
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish.mock.calls[1][0]).toEqual([]);
    hold.schedule(ids[1]); hold.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("keeps snapshot and publication failures visible, and retries on later capture", async () => {
    const roots = await setup(); const [id] = seed();
    vi.useFakeTimers();
    const publish = vi.spyOn(AuditArchive.prototype, "ensureMany").mockReturnValue({ archived: [], failed: [id] });
    const hold = roots.audit as any;
    hold.schedule(id); await vi.advanceTimersByTimeAsync(1500);
    expect(roots.audit.status().failures).toHaveLength(1);
    publish.mockImplementationOnce(() => { throw new Error("private payload must not leak"); });
    hold.schedule(id); await vi.advanceTimersByTimeAsync(1500);
    expect(roots.audit.status().failures[0].error).not.toContain("private payload");
    publish.mockRestore();
    hold.schedule(id); await vi.advanceTimersByTimeAsync(1500);
    expect(roots.audit.status().failures).toEqual([]);
  });

  it("continues after an unavailable snapshot and refuses a concurrent writer", async () => {
    await setup(); const [id] = seed();
    const missing = hex(16);
    expect(archive().ensureMany([missing, id], directory())).toEqual({ archived: [id], failed: [missing] });
    const lock = path.join(directory(), ".writer.lock");
    fs.writeFileSync(lock, "other writer");
    expect(() => archive().ensureMany([id], directory())).toThrow();
    expect(fs.readFileSync(lock, "utf8")).toBe("other writer");
    fs.unlinkSync(lock);
    expect(verify().ok).toBe(true);
  });

  it("reloads a version appended outside a prior background pass", async () => {
    await setup(); const ids = seed(2);
    archive().ensureMany([ids[0]], directory());
    const exported = archive().export(ids[1]);
    tb.roots.store.insertAnnotation({ trace_id: ids[0], span_id: null, label: "note", text: "later", author: "test" });
    archive().ensureMany(ids, directory());
    const entries = verify().entries;
    expect(entries).toHaveLength(3);
    expect(entries[2].prev).toBe(exported.head);
    expect(verify().ok).toBe(true);
  });

  it("rejects a failed final verification without publishing success", async () => {
    await setup(); const [id] = seed();
    const original = manifest.verifyArchive;
    vi.spyOn(manifest, "verifyArchive").mockImplementation((...args) => {
      const result = original(...args);
      return args[1] ? { ...result, ok: false, errors: ["simulated tamper"] } : result;
    });
    expect(() => archive().ensureMany([id], directory())).toThrow(/verification failed/);
    expect(fs.existsSync(path.join(directory(), ".writer.lock"))).toBe(false);
  });

  it("freshly verifies all history and current bytes before deletion despite a prior batch", async () => {
    const roots = await setup(); const ids = seed(2);
    archive().ensureMany(ids, directory());
    const historical = verify().entries[0];
    const target = path.join(directory(), historical.path);
    const original = fs.readFileSync(target); const stat = fs.statSync(target);
    const edited = Buffer.from(original); edited[0] ^= 1;
    fs.writeFileSync(target, edited); fs.utimesSync(target, stat.atime, stat.mtime);
    expect(() => roots.store.deleteRun(ids[1])).toThrow(/audit hold/);
    expect(roots.store.getRun(ids[1])).toBeDefined();
    fs.writeFileSync(target, original);
    roots.store.db.prepare("UPDATE runs SET termination_reason = 'late' WHERE trace_id = ?").run(ids[1]);
    roots.store.deleteRun(ids[1]);
    const last = verify().entries.at(-1)!;
    expect(verify().entries).toHaveLength(3);
    expect(fs.readFileSync(path.join(directory(), path.dirname(last.path), "record.json"), "utf8")).toContain("late");
  });
});

describe("lazy retention candidates", () => {
  it("checks only the oldest visited prefix and checks again at actual deletion", async () => {
    const roots = await setup(); seed(30);
    const guard = vi.fn(); roots.store.deletionGuard = guard;
    expect(roots.store.sweep(0, roots.store.storedBytes() - 1)).toBeGreaterThan(0);
    const distinct = new Set(guard.mock.calls.map(c => c[0]));
    expect(distinct.size).toBeLessThan(30);
    for (const id of distinct) expect(guard.mock.calls.filter(c => c[0] === id)).toHaveLength(2);
  });

  it("visits past held candidates but never checks pinned or unneeded later runs", async () => {
    const roots = await setup(); const ids = seed(30);
    roots.store.setPinned(ids[0], true);
    const guard = vi.fn((id: string) => { if (id === ids[1]) throw new Error("held"); });
    roots.store.deletionGuard = guard;
    const selected = (roots.store as any).oldestRunsCovering(1, roots.store.storedBytes()) as string[];
    expect(selected).toEqual([ids[2]]);
    expect(guard.mock.calls.map(c => c[0])).toEqual([ids[1], ids[2]]);
  });
  it("does not reuse selection permission at the final deletion boundary", async () => {
    const roots = await setup(); const ids = seed(3);
    const seen = new Set<string>();
    roots.store.deletionGuard = (id) => {
      if (seen.has(id)) throw new Error("changed before deletion");
      seen.add(id);
    };
    expect(() => roots.store.sweep(0, roots.store.storedBytes() - 1)).toThrow("changed before deletion");
    for (const id of ids) expect(roots.store.getRun(id)).toBeDefined();
  });

});
