import { afterEach, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, makeRoots, s, span, type TestRoots } from "./helpers.js";

const traceId = "b".repeat(32);
const cleanup: TestRoots[] = [];
afterEach(async () => { for (const tb of cleanup.splice(0)) await tb.close(); });

async function setup() {
  const tb = await makeRoots();
  cleanup.push(tb);
  tb.roots.steering.setMode("test-agent", "advisory");
  tb.roots.engine!.registry.save(parseChecks(`
- id: cache-not-reused
  kind: rule
  title: Cache not reused
  rule: { type: cache_reuse }
  guidance: Check cache reuse.
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
