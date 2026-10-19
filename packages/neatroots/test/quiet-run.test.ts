import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, mockLlm, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("quiet runs (issue #569)", () => {
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
});
