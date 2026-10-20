import { afterEach, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

it("emits finding update on roots.bus when claim transitions a finding to active", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "s", user: "u" })], "test-agent")]);
  const f = tb.roots.store.insertFinding({
    trace_id: t,
    check_id: "test-check",
    check_kind: "rule",
    title: "Test Check",
    probability: null,
    status: "raised",
    evidence_span_ids: [],
    detail: {},
    model: null,
    triage_score: null,
    explanation_id: null,
  });

  tb.roots.steering.setMode("test-agent", "advisory");
  tb.roots.steering.push({ traceId: t, findingId: f.id, kind: "template", text: "Guidance note" });

  const events: any[] = [];
  tb.roots.bus.on("finding", (finding) => events.push(finding));

  const note = tb.roots.steering.claim(t);
  expect(note).toBeDefined();

  expect(events.length).toBe(1);
  expect(events[0].id).toBe(f.id);
  expect(events[0].status).toBe("active");
});
