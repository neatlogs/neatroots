import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, toolSpan } from "./helpers.js";

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
