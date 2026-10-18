import { afterEach, expect, it, vi } from "vitest";
import { archiveObservations } from "../src/audit/observations.js";
import { namedUnknownProjects } from "../src/audit/project-evidence.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });

it("keeps real-engine hold counts without per-run progress queries on a large mixed store", async () => {
  t = await makeRoots({ config: c => { c.audit.enabled = true; c.projects.excluded = { audit: false }; } });
  const { roots } = t, engine = roots.engine!;
  const complete = Array.from({ length: 208 }, () => hex(16));
  const excluded = Array.from({ length: 20 }, () => hex(16));
  const named = hex(16), absent = hex(16), doctor = hex(16);
  // Store ingestion leaves the real engine idle; the states below are controlled independently.
  roots.store.ingest([
    ...complete.map(id => batch([span({ name: "fixture", traceId: id, kind: "workflow" })], "covered")),
    ...excluded.map(id => batch([span({ name: "fixture", traceId: id, kind: "workflow" })], "excluded")),
    batch([span({ name: "fixture", traceId: named, kind: "workflow" })], "unknown"),
    { resource: { attributes: [] }, scope: { attributes: [] }, spans: [span({ name: "fixture", traceId: absent, kind: "workflow" })] },
    batch([span({ name: "fixture", traceId: doctor, kind: "workflow" })], "covered"),
  ]);
  roots.store.db.prepare("UPDATE runs SET doctor=1 WHERE trace_id=?").run(doctor);
  const [incomplete, checking, interrupted, audit, tracked, dirty, delayed, idle] = complete;
  roots.store.db.prepare("UPDATE runs SET complete=0,root_ended=0 WHERE trace_id=?").run(incomplete);
  engine.progress.checking(checking);
  engine.progress.interrupted(interrupted);
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const internals = engine as any;
  const work = [internals.auditJob(audit, () => blocked), internals.track(tracked, blocked),
    internals.auditJob(excluded[0], () => blocked), internals.auditJob(doctor, () => blocked)];
  const dirtyRun = internals.liveRun(dirty); dirtyRun.endHandled = true; dirtyRun.dirty.add("pending-question");
  internals.liveRun(delayed); // End handling is outstanding, without a persisted progress row.
  internals.liveRun(idle).endHandled = true;
  try {
    // Reference the pre-change safe policy and SQL aggregator, not the new helper.
    const pending = (roots.store.db.prepare("SELECT trace_id FROM runs WHERE doctor=0").all() as { trace_id: string }[])
      .filter(r => !engine.auditReady(r.trace_id)).map(r => r.trace_id);
    const expected = archiveObservations(roots.store).status(roots.audit.directory(), ["covered", "unknown"], namedUnknownProjects(roots.store), true, pending);
    expect(expected).toMatchObject({ covered_runs: 209, held_runs: 209, hold_reasons: {
      "run has not ended": 1, "checks are pending or interrupted": 6, "archive observation unavailable or stale": 202,
    } });
    const progress = vi.spyOn(engine.progress, "state").mockImplementation(() => { throw new Error("status must not query progress per run"); });
    expect(roots.audit.status()).toEqual({ enabled: true, directory: roots.audit.directory(), ...expected });
    expect(progress).not.toHaveBeenCalled();
  } finally {
    finish(); await Promise.all(work);
  }
});

it("does not include zero job counters or idle live state in the in-memory busy set", async () => {
  t = await makeRoots();
  const engine = t.roots.engine!, internals = engine as any;
  const zero = hex(16), active = hex(16);
  internals.auditJobs.set(zero, 0); internals.jobs.set(zero, 0);
  internals.auditJobs.set(active, 2); internals.jobs.set(active, 1);
  expect(engine.auditBusy()).toEqual([active]);
});

it("preserves no-engine and incomplete hold reasons", async () => {
  t = await makeRoots({ noEngine: true, config: c => { c.audit.enabled = true; } });
  const done = hex(16), live = hex(16);
  t.roots.store.ingest([batch([span({ name: "fixture", traceId: done, kind: "workflow" }), span({ name: "fixture", traceId: live, kind: "workflow" })], "covered")]);
  t.roots.store.db.prepare("UPDATE runs SET complete=0,root_ended=0 WHERE trace_id=?").run(live);
  expect(t.roots.audit.status()).toMatchObject({ covered_runs: 2, held_runs: 2,
    hold_reasons: { "run has not ended": 1, "check engine unavailable": 1 } });
});
