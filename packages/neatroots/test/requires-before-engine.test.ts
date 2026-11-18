import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, toolSpan, until, type TestRoots } from "./helpers.js";

// Spans from one run can reach neatroots out of order (two exporters, batching). These tests
// send the refund before the lookup that really happened first, as separate batches.

const RULE = parseChecks(`
- id: lookup-before-refund
  kind: rule
  title: Refund without looking up the order
  rule:
    type: requires_before
    span: { tool: issue_refund }
    requires: { tool: lookup_order }
  guidance: "{tool} was called with no earlier successful {requires} call."
  action: halt
`).checks[0];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup() {
  const tb = await makeRoots();
  // Halts reach the agent only while steering is on for the project (off sends nothing).
  tb.roots.steering.setMode("test-agent", "advisory");
  cleanup.push(() => tb.close());
  tb.roots.engine!.registry.save(RULE, "user");
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { user: "Refund order 4512", tools: ["lookup_order", "issue_refund"] })])]);
  // The lookup starts and ends before the refund.
  const lookup = toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', '{"ok":true}');
  const refund = toolSpan(t, root, "issue_refund", '{"order_id":"4512"}', '{"ok":true}');
  return { tb, t, lookup, refund };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finding = (tb: TestRoots, t: string) => tb.roots.store.findingsForTrace(t).find((f) => f.check_id === "lookup-before-refund");
const halts = (tb: TestRoots, t: string) => tb.roots.store.notesForTrace(t, "pending").filter((n) => n.kind === "halt");

describe("requires_before with spans out of order", () => {
  it("raises nothing when the earlier lookup arrives just after the refund", async () => {
    const { tb, t, lookup, refund } = await setup();
    tb.roots.ingest([batch([refund])]);
    await sleep(50);
    tb.roots.ingest([batch([lookup])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(finding(tb, t)).toBeUndefined();
    expect(halts(tb, t)).toEqual([]);
    expect(tb.roots.steering.claim(t, null)).toBeUndefined();
  });

  it("resolves the finding and withdraws the halt when the lookup arrives late", async () => {
    const { tb, t, lookup, refund } = await setup();
    tb.roots.ingest([batch([refund])]);
    const f = await until(() => finding(tb, t));
    expect(f.status).toBe("raised");
    expect(halts(tb, t)).toHaveLength(1);
    tb.roots.ingest([batch([lookup])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(tb.roots.store.getFinding(f.id)!.status).toBe("resolved");
    expect(halts(tb, t)).toEqual([]);
  });

  it("still raises and halts when the lookup never happened", async () => {
    const { tb, t, refund } = await setup();
    tb.roots.ingest([batch([refund])]);
    // Within a second: the halt reaches the agent's next LLM call.
    const f = await until(() => finding(tb, t), 1000);
    expect(f.status).toBe("raised");
    expect(f.evidence_span_ids).toEqual([refund.spanId]);
    const note = tb.roots.steering.claim(t, null)!;
    expect(note.kind).toBe("halt");
    expect(note.text).toBe("issue_refund was called with no earlier successful lookup_order call.");
  });

  it("still raises when the only lookup started after the refund", async () => {
    const { tb, t, refund } = await setup();
    tb.roots.ingest([batch([refund])]);
    await sleep(20);
    tb.roots.ingest([batch([toolSpan(t, hex(8), "lookup_order", "{}", '{"ok":true}')])]);
    await until(() => finding(tb, t), 2000);
    expect(halts(tb, t)).toHaveLength(1);
  });
});
