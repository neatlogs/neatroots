import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, type TestRoots } from "./helpers.js";

// Steering note budget enforcement (#109).

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(maxNotes = 2): Promise<{ tb: TestRoots; t: string }> {
  const tb = await makeRoots({
    serve: true,
    noEngine: true,
    config: (c) => {
      c.steering.enabled = true;
      c.steering.maxNotesPerRun = maxNotes;
      c.projects["test-agent"] = { steering: "advisory" };
    },
  });
  cleanup.push(tb.close);
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "You are an agent.", user: "Do tasks" })])]);
  tb.roots.steering.setMode("test-agent", "advisory");
  return { tb, t };
}

describe("steering maxNotesPerRun budget", () => {
  it("delivers at most maxNotesPerRun advisory notes across multiple turns", async () => {
    const { tb, t } = await setup(2);

    // Queue 4 advisory notes
    const n1 = tb.roots.steering.push({ traceId: t, findingId: "f1", kind: "template", text: "Note 1" });
    const n2 = tb.roots.steering.push({ traceId: t, findingId: "f2", kind: "template", text: "Note 2" });
    const n3 = tb.roots.steering.push({ traceId: t, findingId: "f3", kind: "template", text: "Note 3" });
    const n4 = tb.roots.steering.push({ traceId: t, findingId: "f4", kind: "template", text: "Note 4" });

    // Note 1 and Note 2 queue, Note 3 and Note 4 are rejected by push budget
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect(n3).toBeUndefined();
    expect(n4).toBeUndefined();

    const c1 = tb.roots.steering.claim(t);
    const c2 = tb.roots.steering.claim(t);
    const c3 = tb.roots.steering.claim(t);

    expect(c1?.text).toBe("Note 1");
    expect(c2?.text).toBe("Note 2");
    expect(c3).toBeUndefined();
    expect(tb.roots.steering.deliveredCount(t)).toBe(2);
  });

  it("expires remaining pending advisory notes in claim when budget is reached", async () => {
    const { tb, t } = await setup(1);

    // Insert 2 pending notes directly
    tb.roots.store.insertNote({ trace_id: t, finding_id: "f1", kind: "template", text: "Note 1", status: "pending", checks: null });
    tb.roots.store.insertNote({ trace_id: t, finding_id: "f2", kind: "template", text: "Note 2", status: "pending", checks: null });

    const c1 = tb.roots.steering.claim(t);
    expect(c1?.text).toBe("Note 1");

    // Second claim exceeds maxNotesPerRun = 1, so Note 2 expires
    const c2 = tb.roots.steering.claim(t);
    expect(c2).toBeUndefined();
    expect(tb.roots.steering.deliveredCount(t)).toBe(1);

    const pending = tb.roots.store.notesForTrace(t, "pending");
    expect(pending).toHaveLength(0);
    const expired = tb.roots.store.notesForTrace(t, "expired");
    expect(expired.some((n) => n.text === "Note 2")).toBe(true);
  });

  it("does not block halt notes even after advisory budget is exhausted", async () => {
    const { tb, t } = await setup(1);

    tb.roots.steering.push({ traceId: t, findingId: "f1", kind: "template", text: "Advisory note 1" });
    const c1 = tb.roots.steering.claim(t);
    expect(c1?.text).toBe("Advisory note 1");
    expect(tb.roots.steering.deliveredCount(t)).toBe(1);

    // Advisory budget is full, but halt notes always go through
    const halt = tb.roots.steering.push({ traceId: t, findingId: "f2", kind: "halt", text: "Fatal error: halt" });
    expect(halt).toBeDefined();

    const c2 = tb.roots.steering.claim(t);
    expect(c2?.kind).toBe("halt");
    expect(c2?.text).toBe("Fatal error: halt");
  });

  it("withdraw frees queue space when an uncalled pending note is withdrawn", async () => {
    const { tb, t } = await setup(1);

    const f1 = tb.roots.store.insertFinding({
      trace_id: t,
      check_id: "check1",
      check_kind: "rule",
      title: "Problem 1",
      probability: null,
      status: "raised",
      evidence_span_ids: [],
      detail: {},
      model: null,
      triage_score: null,
      explanation_id: null,
    });

    const n1 = tb.roots.steering.push({ traceId: t, findingId: f1.id, kind: "template", text: "Note 1" });
    expect(n1).toBeDefined();

    // Limit is 1, so next push fails
    expect(tb.roots.steering.push({ traceId: t, findingId: "f2", kind: "template", text: "Note 2" })).toBeUndefined();

    // Finding f1 is withdrawn (resolved or dismissed)
    tb.roots.steering.withdraw(f1.id);

    // Now a new note can be queued
    const n3 = tb.roots.steering.push({ traceId: t, findingId: "f3", kind: "template", text: "Note 3" });
    expect(n3).toBeDefined();
    expect(tb.roots.steering.claim(t)?.text).toBe("Note 3");
  });
});
