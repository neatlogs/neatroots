import { afterEach, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { evaluateRule } from "../src/checks/rules.js";
import { loadTrace } from "../src/engine/trace.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

const traceId = "b".repeat(32);
const cleanup: TestRoots[] = [];
afterEach(async () => { for (const tb of cleanup.splice(0)) await tb.close(); });

async function setup(halt = false) {
  const tb = await makeRoots();
  cleanup.push(tb);
  tb.roots.steering.setMode("test-agent", halt ? "gate" : "advisory");
  tb.roots.engine!.registry.save(parseChecks(`
- id: cache-not-reused
  kind: rule
  title: Cache not reused
  rule: { type: cache_reuse }
  guidance: Check cache reuse.
  ${halt ? "action: halt" : ""}
`).checks[0], "user");
  const root = span({ traceId, name: "agent", kind: "agent" });
  const calls = [[0, 100], [0, 100], [0, 100], [300, 0]].map(([read, write]) =>
    span({ traceId, parent: root.spanId, kind: "llm", name: "chat", attrs: [
      s("neatlogs.llm.provider", "anthropic"), s("neatlogs.llm.model_name", "claude"),
      s("neatlogs.llm.token_count.cache_read", read), s("neatlogs.llm.token_count.cache_write", write),
    ] }));
  return { tb, root, calls };
}

function findings(tb: TestRoots) {
  return tb.roots.store.findingsForTrace(traceId).filter((f) => f.check_id === "cache-not-reused");
}

for (const update of ["later reads", "same-ID writes"] as const) {
  it(`refreshes cache totals without changing evidence or duplicating a halt after ${update}`, async () => {
    const { tb, calls } = await setup(true);
    tb.roots.ingest([batch(calls.slice(0, 3))]);
    expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    const [raised] = findings(tb);
    expect(raised?.status).toBe("raised");
    expect(raised.detail.params).toEqual({ cache_write: "200", cache_read: "0" });
    const pending = tb.roots.store.notesForTrace(traceId, "pending");
    expect(pending).toMatchObject([{ kind: "halt", finding_id: raised.id }]);
    const attributes = update === "later reads"
      ? calls[3].attributes.map((a) => a.key === "neatlogs.llm.token_count.cache_read" ? s(a.key, 50) : a)
      : calls[1].attributes.map((a) => a.key === "neatlogs.llm.token_count.cache_write" ? s(a.key, 150) : a);
    const changed = { ...(update === "later reads" ? calls[3] : calls[1]), attributes };
    tb.roots.ingest([batch([changed])]);
    expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    const current = tb.roots.store.getFinding(raised.id)!;
    expect(current.status).toBe("raised");
    expect(current.evidence_span_ids).toEqual(raised.evidence_span_ids);
    expect(current.detail.params).toEqual(update === "later reads"
      ? { cache_write: "200", cache_read: "50" } : { cache_write: "250", cache_read: "0" });
    expect(current.detail.source).toBe(raised.detail.source);
    expect(findings(tb)).toHaveLength(1);
    expect(tb.roots.store.notesForTrace(traceId, "pending").map((n) => n.id)).toEqual(pending.map((n) => n.id));
  });
}

for (const correction of ["replacement", "identity", "late read"] as const) {
  it(`withdraws an erased cache halt before the next gate claim after ${correction}`, async () => {
    const { tb, calls } = await setup(true);
    tb.roots.ingest([batch(calls.slice(0, 3))]);
    expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    const [raised] = findings(tb);
    expect(raised?.status).toBe("raised");
    expect(tb.roots.store.notesForTrace(traceId, "pending").filter((n) => n.finding_id === raised.id)).toMatchObject([{ kind: "halt" }]);
    const changed = correction === "late read"
      ? { ...calls[3], startTimeUnixNano: (BigInt(calls[0].endTimeUnixNano) + 1n).toString() }
      : { ...calls[2], attributes: correction === "identity"
        ? calls[2].attributes.filter((a) => a.key !== "neatlogs.llm.model_name") : [...calls[3].attributes] };
    tb.roots.ingest([batch([changed])]);
    expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    expect(tb.roots.store.getFinding(raised.id)?.status).toBe("resolved");
    expect(await tb.roots.steering.gate(traceId, 1000)).toBeUndefined();
    expect(tb.roots.store.notesForTrace(traceId, "pending").filter((n) => n.finding_id === raised.id)).toEqual([]);
  });
}

it("retains a user halt when a real historical cache failure recovers", async () => {
  const { tb, calls } = await setup(true);
  tb.roots.ingest([batch(calls.slice(0, 3))]);
  expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
  const [raised] = findings(tb);
  expect(raised?.status).toBe("raised");
  tb.roots.ingest([batch([calls[3]])]);
  expect(await tb.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
  expect(tb.roots.store.getFinding(raised.id)?.status).toBe("resolved");
  expect(await tb.roots.steering.gate(traceId, 1000)).toMatchObject({ kind: "halt", finding_id: raised.id });
});

for (const correction of ["late read", "replacement", "unknown counters", "missing identity"] as const) {
  it(`reconciles an open cache finding after ${correction} erases its prefixes`, async () => {
    const { tb, calls } = await setup();
    tb.roots.ingest([batch(calls.slice(0, 3))]);
    await tb.roots.engine!.waitIdle(traceId, 5000);
    const [raised] = findings(tb);
    expect(raised?.status).toBe("raised");
    expect(tb.roots.store.notesForTrace(traceId, "pending").some((n) => n.finding_id === raised.id)).toBe(true);
    let changed = { ...calls[2], attributes: [...calls[3].attributes] };
    if (correction === "late read") {
      changed = { ...calls[3], startTimeUnixNano: (BigInt(calls[0].endTimeUnixNano) + 1n).toString() };
    } else if (correction === "unknown counters") {
      changed.attributes = changed.attributes.filter((a) => !a.key.includes("token_count.cache"));
    } else if (correction === "missing identity") {
      changed.attributes = changed.attributes.filter((a) => a.key !== "neatlogs.llm.model_name");
    }
    tb.roots.ingest([batch([changed])]);
    await tb.roots.engine!.waitIdle(traceId, 5000);
    const rule = tb.roots.engine!.registry.rules().find((c) => c.check.id === "cache-not-reused")!.check as RuleCheck;
    expect(evaluateRule(rule, loadTrace(tb.roots.store, traceId), false)).toBeNull();
    expect(tb.roots.store.getFinding(raised.id)?.status).toBe("resolved");
    expect(tb.roots.store.notesForTrace(traceId, "pending").filter((n) => n.finding_id === raised.id)).toEqual([]);

    // The final authoritative telemetry creates no actionable finding when ingested in one batch.
    const other = hex(16);
    const final = correction === "late read" ? [...calls.slice(0, 3), changed] : [...calls.slice(0, 2), changed];
    tb.roots.ingest([batch(final.map((c) => ({ ...c, traceId: other })).reverse())]);
    await tb.roots.engine!.waitIdle(other, 5000);
    expect(tb.roots.store.findingsForTrace(other).filter((f) => f.check_id === rule.id)).toEqual([]);
    expect(tb.roots.store.notesForTrace(other, "pending")).toEqual([]);
  });
}

it("keeps a still-firing cache finding raised after an unrelated span replacement", async () => {
  const { tb, calls } = await setup();
  tb.roots.ingest([batch(calls.slice(0, 3))]);
  await tb.roots.engine!.waitIdle(traceId, 5000);
  const [raised] = findings(tb);
  expect(raised?.status).toBe("raised");
  tb.roots.ingest([batch([{ ...calls[2], name: "corrected name" }])]);
  await tb.roots.engine!.waitIdle(traceId, 5000);
  expect(tb.roots.store.getFinding(raised.id)?.status).toBe("raised");
});

it("resolves a live cache finding and withdraws pending guidance after reads recover", async () => {
  const { tb, calls } = await setup();
  // The root has not ended yet; these child calls arrive while the agent is live.
  tb.roots.ingest([batch(calls.slice(0, 3))]);
  await tb.roots.engine!.waitIdle(traceId, 5000);
  const [raised] = findings(tb);
  expect(raised?.status).toBe("raised");
  expect(raised.evidence_span_ids).toEqual(calls.slice(1, 3).map((c) => c.spanId));
  expect(tb.roots.store.notesForTrace(traceId, "pending").some((n) => n.finding_id === raised.id)).toBe(true);
  tb.roots.ingest([batch([calls[3]])]);
  await tb.roots.engine!.waitIdle(traceId, 5000);
  expect(tb.roots.store.getFinding(raised.id)?.status).toBe("resolved");
  expect(tb.roots.store.notesForTrace(traceId, "pending").filter((n) => n.finding_id === raised.id)).toEqual([]);
  expect(tb.roots.steering.claim(traceId, null)).toBeUndefined();
});

it("leaves no actionable cache finding when the recovered trace arrives in one reversed batch", async () => {
  const { tb, root, calls } = await setup();
  // Use a separate run, with the same chronological cache measurements.
  const other = hex(16);
  for (const c of [root, ...calls]) c.traceId = other;
  tb.roots.ingest([batch([root, ...calls].reverse())]);
  await tb.roots.engine!.waitIdle(other, 5000);
  expect(tb.roots.store.findingsForTrace(other).filter((f) => f.check_id === "cache-not-reused")).toEqual([]);
  expect(tb.roots.store.notesForTrace(other, "pending")).toEqual([]);
  expect(tb.roots.steering.claim(other, null)).toBeUndefined();
});
