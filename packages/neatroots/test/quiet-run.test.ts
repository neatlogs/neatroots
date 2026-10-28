import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { resumeUnfinished } from "../src/engine/engine.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, toolSpan, until } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("quiet runs (issue #213)", () => {
  it("ends a run whose end never arrived after it goes quiet, and still runs its end checks", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });

    // the run's root span never arrives - only children do, then the agent dies (issue #569)
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "refund order 4512" })])]);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", '{"order_id":"4512"}')])]);
    expect(tb.roots.store.getRun(t)!.status).toBe("running");

    // nothing new arrives for a while: the run went quiet
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, t);

    await tb.roots.engine!.endQuietRuns(30 * 60_000);

    const row = tb.roots.store.getRun(t)!;
    expect(row.status).toBe("interrupted");
    expect(row.interrupted).toBe(1);
    expect(row.termination_reason).toBe("no end received");
    expect(row.ended_ms).toBeTruthy();
    // the run's end-of-run pass actually ran on what arrived
    expect(tb.roots.store.getSummary(t)).toBeTruthy();
  });

  it("leaves a run that is still active alone", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "still going" })])]);

    await tb.roots.engine!.endQuietRuns(30 * 60_000);

    expect(tb.roots.store.getRun(t)!.status).toBe("running");
  });

  it("leaves a completed run alone", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "done but root is missing" })])]);
    tb.roots.ingest([batch([markerSpan(t, root)])]);
    expect(tb.roots.store.getRun(t)!.complete).toBe(1);

    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, t);
    await tb.roots.engine!.endQuietRuns(30 * 60_000);

    const row = tb.roots.store.getRun(t)!;
    expect(row.status).toBe("running");
    expect(row.interrupted).toBe(0);
  });

  it("does not mark a run that reported after the sweep's cutoff", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "racing the sweep" })])]);

    // the run's updated_ms is now: a cutoff half an hour old must not mark it
    expect(tb.roots.store.markRunInterrupted(t, "no end received", Date.now() - 30 * 60_000)).toBe(false);
    expect(tb.roots.store.getRun(t)!.status).toBe("running");
    expect(tb.roots.store.markRunInterrupted(t, "no end received", Date.now() + 1000)).toBe(true);
    expect(tb.roots.store.getRun(t)!.status).toBe("interrupted");
  });

  it("clears the inferred interruption when the run's root or completion marker arrives late", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "root comes late" })])]);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, t);
    await tb.roots.engine!.endQuietRuns(30 * 60_000);
    expect(tb.roots.store.getRun(t)!.status).toBe("interrupted");

    // the agent was alive after all: its completion marker arrives late
    tb.roots.ingest([batch([markerSpan(t, root)])]);
    let row = tb.roots.store.getRun(t)!;
    expect(row.status).toBe("running");
    expect(row.interrupted).toBe(0);
    expect(row.termination_reason).toBeNull();

    // and a late root does the same for a run still waiting on one
    const t2 = hex(16);
    const root2 = hex(8);
    tb.roots.ingest([batch([llmSpan(t2, root2, { user: "root comes late too" })])]);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, t2);
    await tb.roots.engine!.endQuietRuns(30 * 60_000);
    expect(tb.roots.store.getRun(t2)!.status).toBe("interrupted");

    const late = llmSpan(t2, "", { user: "late root", out: "done" });
    late.parentSpanId = undefined;
    tb.roots.ingest([batch([late])]);
    row = tb.roots.store.getRun(t2)!;
    expect(row.interrupted).toBe(0);
    expect(row.termination_reason).toBeNull();
    expect(row.status).not.toBe("interrupted");
  });
});

describe("quiet-run sweep at startup (issue #673)", () => {
  it("lists quiet runs through its own index instead of scanning runs", async () => {
    const tb = await makeRoots({});
    cleanup.push(async () => {
      await tb.close();
    });
    // must mirror Store.quietRuns' statement, including ORDER BY and LIMIT, so an index
    // regression on the production query fails here
    const plan = tb.roots.store.db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM runs WHERE status = 'running' AND doctor = 0 AND complete = 0 AND updated_ms < ? ORDER BY updated_ms ASC LIMIT ?")
      .all(0, -1) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" | ")).toContain("runs_quiet");
  });

  it("startup recovery resumes unrelated runs while a quiet run's recheck is still working", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    // an unrelated run that ended normally, and a run that went quiet
    const a = hex(16);
    const rootA = hex(8);
    tb.roots.ingest([
      batch([
        llmSpan(a, rootA, { user: "refund order 4512" }),
        toolSpan(a, rootA, "lookup_order", '{"order_id":"4512"}'),
        span({ traceId: a, spanId: rootA, name: "refund", kind: "workflow" }),
        markerSpan(a, rootA),
      ]),
    ]);
    const b = hex(16);
    const rootB = hex(8);
    tb.roots.ingest([batch([llmSpan(b, rootB, { user: "long running thing" })])]);

    // let the ended run's live check work settle, then leave both runs the way a crash would:
    // checks outstanding. the quiet run's live work never settles on its own - it has no end.
    await until(() => engine.progress.state(a) === undefined, 15_000);
    engine.progress.checking(a);
    engine.progress.checking(b);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, b);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect(claimed).toEqual([b]);
    expect(tb.roots.store.getRun(b)!.status).toBe("interrupted");

    // the quiet run's recheck is slow - parked here until the test lets it through
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      if (id === b) await gate;
      return orig(id, opts);
    };
    const bg = engine.recheckClaimedQuietRuns(claimed);

    // unrelated startup recovery goes ahead and finishes while the quiet recheck is still parked
    const resumed = await resumeUnfinished(engine, tb.roots);
    expect(resumed).toBe(1);
    expect(engine.progress.state(a)).toBeUndefined();
    expect(engine.isQuietClaimed(b)).toBe(true);

    release();
    await bg;
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.progress.state(b)).toBeUndefined();
    expect(tb.roots.store.getSummary(a)).toBeTruthy();
    expect(tb.roots.store.getSummary(b)).toBeTruthy();
  }, 30_000);

  it("rechecks the rest of the batch when one quiet run's recheck fails", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const mk = () => {
      const t = hex(16);
      tb.roots.ingest([batch([llmSpan(t, hex(8), { user: "quiet run" })])]);
      return t;
    };
    const b = mk();
    const c = mk();
    // leave both the way a crash would: checks outstanding, no end (a quiet run's live work
    // never settles on its own).
    engine.progress.checking(b);
    engine.progress.checking(c);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ?, last_span_ms = ? WHERE trace_id IN (?, ?)")
      .run(Date.now() - 31 * 60_000, Date.now() - 31 * 60_000, b, c);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect([...claimed].sort()).toEqual([b, c].sort());

    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      if (id === b) throw new Error("model down");
      return orig(id, opts);
    };

    // must not reject, and the later claimed run still gets its end-of-run pass
    await engine.recheckClaimedQuietRuns(claimed);
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.isQuietClaimed(c)).toBe(false);
    expect(tb.roots.store.getSummary(c)).toBeTruthy();

    // the failed run goes back to running so a later sweep retries it
    expect(tb.roots.store.getRun(b)!.status).toBe("running");
    expect(engine.claimQuietRuns(30 * 60_000)).toEqual([b]);
    expect(tb.roots.store.getRun(b)!.status).toBe("interrupted");
  }, 30_000);

  it("does not resurrect a run that ended for real before its failed recheck was restored", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const b = hex(16);
    tb.roots.ingest([batch([llmSpan(b, hex(8), { user: "quiet run" })])]);
    engine.progress.checking(b);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?")
      .run(Date.now() - 31 * 60_000, b);

    expect(engine.claimQuietRuns(30 * 60_000)).toEqual([b]);

    // the run's real end lands mid-flight: the guard still reads interrupted when the loop
    // reaches it, the end persists during the recheck, and the recheck fails. the restore
    // must not flip the finished row back to running.
    let flipped = false;
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async () => {
      tb.roots.store.db.prepare("UPDATE runs SET status = 'ok' WHERE trace_id = ?").run(b);
      flipped = true;
      throw new Error("model down");
    };
    await engine.recheckClaimedQuietRuns([b]);
    expect(flipped).toBe(true);
    expect(tb.roots.store.getRun(b)!.status).toBe("ok");
    expect(engine.isQuietClaimed(b)).toBe(false);
  }, 30_000);

  it("keeps rechecking the batch when restoring a failed run itself fails", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const mk = () => {
      const t = hex(16);
      tb.roots.ingest([batch([llmSpan(t, hex(8), { user: "quiet run" })])]);
      return t;
    };
    const b = mk();
    const c = mk();
    engine.progress.checking(b);
    engine.progress.checking(c);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id IN (?, ?)")
      .run(Date.now() - 31 * 60_000, b, c);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect([...claimed].sort()).toEqual([b, c].sort());

    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      if (id === b) throw new Error("model down");
      return orig(id, opts);
    };
    (tb.roots.store as unknown as { restoreQuietRun: (id: string) => void }).restoreQuietRun = () => {
      throw new Error("database is locked");
    };

    // must not reject: b stays interrupted (no retry) and c still gets its end-of-run pass
    await engine.recheckClaimedQuietRuns(claimed);
    expect(tb.roots.store.getRun(b)!.status).toBe("interrupted");
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.isQuietClaimed(c)).toBe(false);
    expect(tb.roots.store.getSummary(c)).toBeTruthy();
  }, 30_000);

  it("recovers a crashed sweep's abandoned claims on a later sweep", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    // the way a crash leaves a claimed run behind: interrupted by the sweep, no owner, no
    // outstanding progress row for resumeUnfinished to find
    const b = hex(16);
    tb.roots.ingest([batch([llmSpan(b, hex(8), { user: "quiet run" })])]);
    // no outstanding progress row, the way a crash leaves a run whose checks had settled
    engine.progress.checking(b);
    engine.progress.done(b);
    tb.roots.store.db
      .prepare("UPDATE runs SET status = 'interrupted', interrupted = 1, termination_reason = 'no end received', updated_ms = ? WHERE trace_id = ?")
      .run(Date.now() - 31 * 60_000, b);

    // a normal quiet run for the claim pass
    const c = hex(16);
    tb.roots.ingest([batch([llmSpan(c, hex(8), { user: "quiet run" })])]);
    engine.progress.checking(c);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?")
      .run(Date.now() - 31 * 60_000, c);

    await engine.endQuietRuns(30 * 60_000);
    // both got their end-of-run pass: the freshly claimed run and the abandoned one
    expect(tb.roots.store.getSummary(c)).toBeTruthy();
    expect(tb.roots.store.getSummary(b)).toBeTruthy();
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.isQuietClaimed(c)).toBe(false);
  }, 30_000);

  it("leaves an abandoned claim to the sweep that already owns it", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const b = hex(16);
    tb.roots.ingest([batch([llmSpan(b, hex(8), { user: "quiet run" })])]);
    engine.progress.checking(b);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?")
      .run(Date.now() - 31 * 60_000, b);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect(claimed).toEqual([b]);

    // park b's recheck mid-flight, then run the periodic sweep: it must not recheck b again
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      calls.push(id);
      if (id === b) await gate;
      return orig(id, opts);
    };
    const bg = engine.recheckClaimedQuietRuns(claimed);
    await until(() => calls.includes(b), 15_000);

    await engine.endQuietRuns(30 * 60_000);
    expect(calls.filter((id) => id === b)).toHaveLength(1);

    release();
    await bg;
    expect(calls.filter((id) => id === b)).toHaveLength(1);
    expect(engine.isQuietClaimed(b)).toBe(false);
  }, 30_000);

  it("stops claiming at a failed mark and still rechecks the runs it claimed", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const mk = () => {
      const t = hex(16);
      tb.roots.ingest([batch([llmSpan(t, hex(8), { user: "quiet run" })])]);
      return t;
    };
    const b = mk();
    const c = mk();
    engine.progress.checking(b);
    engine.progress.checking(c);
    // b is the stalest, so the claim loop reaches it first
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 32 * 60_000, b);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, c);

    const store = tb.roots.store as unknown as {
      markRunInterrupted: (id: string, reason: string, cutoff: number) => boolean;
    };
    const origMark = store.markRunInterrupted.bind(tb.roots.store);
    store.markRunInterrupted = (id, reason, cutoff) => {
      if (id === c) throw new Error("database is locked");
      return origMark(id, reason, cutoff);
    };

    // the failed mark stops the loop; the run it failed on stays running for the next sweep
    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect(claimed).toEqual([b]);
    expect(tb.roots.store.getRun(c)!.status).toBe("running");
    store.markRunInterrupted = origMark;

    await engine.recheckClaimedQuietRuns(claimed);
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(tb.roots.store.getSummary(b)).toBeTruthy();
    // and the next sweep picks up the run the failed mark left running
    expect(engine.claimQuietRuns(30 * 60_000)).toEqual([c]);
  }, 30_000);

  it("skips a claimed run that already ended normally", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const mk = () => {
      const t = hex(16);
      tb.roots.ingest([batch([llmSpan(t, hex(8), { user: "quiet run" })])]);
      return t;
    };
    const b = mk();
    const c = mk();
    engine.progress.checking(b);
    engine.progress.checking(c);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id IN (?, ?)")
      .run(Date.now() - 31 * 60_000, b, c);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect([...claimed].sort()).toEqual([b, c].sort());

    const calls: string[] = [];
    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      calls.push(id);
      return orig(id, opts);
    };
    // b's real end arrives after the sweep claimed it
    (engine as unknown as { live: Map<string, { ended: boolean }> }).live.get(b)!.ended = true;

    await engine.recheckClaimedQuietRuns(claimed);
    expect(calls).toEqual([c]);
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.isQuietClaimed(c)).toBe(false);
  }, 30_000);

  it("skips a claimed run whose persisted end landed after the claim", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    const engine = tb.roots.engine!;

    const mk = () => {
      const t = hex(16);
      tb.roots.ingest([batch([llmSpan(t, hex(8), { user: "quiet run" })])]);
      return t;
    };
    const b = mk();
    const c = mk();
    const d = mk();
    engine.progress.checking(b);
    engine.progress.checking(c);
    engine.progress.checking(d);
    tb.roots.store.db
      .prepare("UPDATE runs SET updated_ms = ? WHERE trace_id IN (?, ?, ?)")
      .run(Date.now() - 31 * 60_000, b, c, d);

    const claimed = engine.claimQuietRuns(30 * 60_000);
    expect([...claimed].sort()).toEqual([b, c, d].sort());

    const calls: string[] = [];
    const orig = engine.recheck.bind(engine);
    (engine as unknown as { recheck: (id: string, opts?: { resume?: boolean }) => Promise<void> }).recheck = async (id, opts) => {
      calls.push(id);
      return orig(id, opts);
    };
    // b and d's real ends land after the claim and their live entries are already gone
    // (releaseLive), so only the persisted rows can tell the sweep they ended - one
    // normally, one with an error; both keep their own end pass
    const live = (engine as unknown as { live: Map<string, unknown> }).live;
    live.delete(b);
    live.delete(d);
    tb.roots.store.db.prepare("UPDATE runs SET status = 'ok' WHERE trace_id = ?").run(b);
    tb.roots.store.db.prepare("UPDATE runs SET status = 'error' WHERE trace_id = ?").run(d);

    await engine.recheckClaimedQuietRuns(claimed);
    expect(calls).toEqual([c]);
    expect(engine.isQuietClaimed(b)).toBe(false);
    expect(engine.isQuietClaimed(c)).toBe(false);
    expect(engine.isQuietClaimed(d)).toBe(false);
  }, 30_000);
});


describe("completed quiet sweeps", () => {
  it("does not recheck completed work after live release, including after reopening the store", async () => {
    const llm = await mockLlm({ yesWhen: [] });
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => { await tb.close(); await llm.close(); });
    const engine = tb.roots.engine!;
    const id = hex(16);
    tb.roots.ingest([batch([llmSpan(id, hex(8), { user: "quiet run" })])]);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = ? WHERE trace_id = ?").run(Date.now() - 31 * 60_000, id);
    await engine.endQuietRuns(30 * 60_000);
    expect(tb.roots.store.getSummary(id)).toBeTruthy();
    // Simulate releaseLive after its grace period, without waiting a real minute.
    (engine as unknown as { live: Map<string, unknown> }).live.delete(id);
    const calls: string[] = [];
    const original = engine.recheck.bind(engine);
    engine.recheck = async (traceId, opts) => { calls.push(traceId); return original(traceId, opts); };
    await engine.endQuietRuns(30 * 60_000);
    await engine.endQuietRuns(30 * 60_000);
    expect(calls).toEqual([]);
    const reopened = new Store(tb.roots.store.dir);
    try { expect(reopened.abandonedQuietRuns(200)).toEqual([]); } finally { reopened.close(); }
  }, 30_000);
});


it("filters completed quiet sweeps before the abandoned batch limit", async () => {
  const tb = await makeRoots({ noEngine: true });
  cleanup.push(() => tb.close());
  const completed = Array.from({ length: 201 }, () => hex(16));
  const pending = hex(16);
  for (const id of [...completed, pending]) {
    tb.roots.ingest([batch([llmSpan(id, hex(8), { user: "quiet" })])]);
    tb.roots.store.db.prepare("UPDATE runs SET updated_ms = 1 WHERE trace_id = ?").run(id);
    expect(tb.roots.store.markRunInterrupted(id, "no end received", Date.now())).toBe(true);
  }
  for (const id of completed) tb.roots.store.completeQuietRun(id);
  expect(tb.roots.store.abandonedQuietRuns(200).map((r) => r.trace_id)).toEqual([pending]);
});


it("adds the completion flag to an old store and keeps abandoned work recoverable", async () => {
  const tb = await makeRoots({ noEngine: true });
  cleanup.push(() => tb.close());
  const id = hex(16);
  tb.roots.ingest([batch([llmSpan(id, hex(8), { user: "legacy quiet" })])]);
  tb.roots.store.db.prepare("UPDATE runs SET status = 'interrupted', termination_reason = 'no end received' WHERE trace_id = ?").run(id);
  tb.roots.store.db.exec("ALTER TABLE runs DROP COLUMN quiet_sweep_done");
  const reopened = new Store(tb.roots.store.dir);
  try {
    expect(reopened.abandonedQuietRuns(200).map((r) => r.trace_id)).toEqual([id]);
    reopened.completeQuietRun(id);
    expect(reopened.abandonedQuietRuns(200)).toEqual([]);
    reopened.restoreQuietRun(id);
    expect(reopened.markRunInterrupted(id, "no end received", Date.now() + 1)).toBe(true);
    expect(reopened.abandonedQuietRuns(200).map((r) => r.trace_id)).toEqual([id]);
  } finally { reopened.close(); }
});
