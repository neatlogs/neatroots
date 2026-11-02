import { afterEach, describe, expect, it, vi } from "vitest";
import type { OtlpLogRecord } from "../src/otlp/codec.js";
import type { TraceUpdate } from "../src/store/db.js";
import { checkFromInput } from "../src/server/api.js";
import { batch, hex, makeRoots, mockLlm, s, span, until, type TestRoots } from "./helpers.js";

// SDKs batch spans and logs separately, so a span's message content often arrives after the span (and
// after the run ended). Logs go through Roots like spans do, and the runs they change are announced.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0)) await c();
});

const resource = { attributes: [{ key: "service.name", value: { stringValue: "test-agent" } }] };
const log = (traceId: string, spanId: string, eventName: string, key: string, text: string): OtlpLogRecord => ({
  timeUnixNano: "1",
  eventName,
  body: { kvlistValue: { values: [{ key, value: { stringValue: text } }] } },
  attributes: [],
  traceId,
  spanId,
  resource,
  scope: { name: "app" },
});
const llm = (t: string) => span({ traceId: t, name: "chat gpt-4o", kind: "llm", attrs: [s("gen_ai.request.model", "gpt-4o")] });

async function setup() {
  const tb = await makeRoots();
  cleanup.push(() => tb.close());
  const updates: TraceUpdate[] = [];
  tb.roots.bus.on("trace", (u) => updates.push(u));
  return { tb, updates };
}
const late = (updates: TraceUpdate[]) => updates.filter((u) => u.lateLogs);

describe("late GenAI logs through Roots", () => {
  it("announces the run whose span got its content, without ending or creating anything", async () => {
    const { tb, updates } = await setup();
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingest([batch([sp])]);
    updates.length = 0;
    tb.roots.ingestLogs([log(t, sp.spanId, "gen_ai.user.message", "content", "hello"), log(t, sp.spanId, "gen_ai.choice", "message", "hi there")]);
    const [u] = late(updates);
    expect(late(updates)).toHaveLength(1);
    expect(u).toMatchObject({ traceId: t, runCreated: false, rootEnded: false, rootHandedBack: false, completed: false });
    expect(u.spans.map((x) => [x.row.span_id, x.isNew])).toEqual([[sp.spanId, false]]);
    expect(JSON.stringify(u.spans[0].view.input)).toContain("hello");
  });

  it("announces nothing when the logs came before the span, or are not GenAI events", async () => {
    const { tb, updates } = await setup();
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingestLogs([log(t, sp.spanId, "gen_ai.user.message", "content", "hello")]);
    tb.roots.ingest([batch([sp])]);
    const other = llm(hex(16));
    tb.roots.ingest([batch([other])]);
    tb.roots.ingestLogs([log(other.traceId, other.spanId, "app.custom", "x", "y")]);
    expect(late(updates)).toHaveLength(0);
  });

  it("makes the engine look at the refreshed span again", async () => {
    const { tb } = await setup();
    const engine = tb.roots.engine as unknown as { applyRules: (...a: unknown[]) => void };
    const apply = vi.spyOn(engine, "applyRules");
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingest([batch([sp])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    apply.mockClear();
    tb.roots.ingestLogs([log(t, sp.spanId, "gen_ai.choice", "message", "done")]);
    await until(() => apply.mock.calls.some((c) => (c[3] as Set<string> | undefined)?.has(sp.spanId)));
  });

  it("labels a tool span once, not again when its content arrives late", async () => {
    const { tb, updates } = await setup();
    const t = hex(16);
    const sp = span({ traceId: t, name: "execute_tool search", kind: "tool", attrs: [s("gen_ai.tool.name", "search")] });
    tb.roots.ingest([batch([sp])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    const labels = () => tb.roots.store.decisionsForTrace(t).filter((d) => d.check_id === "neatroots.tool-result" && d.span_id === sp.spanId);
    expect(labels()).toHaveLength(1);
    tb.roots.ingestLogs([log(t, sp.spanId, "gen_ai.choice", "message", "results: three hits")]);
    await until(() => late(updates).some((u) => u.spans.some((x) => x.row.span_id === sp.spanId)));
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(labels()).toHaveLength(1);
  });

  it("reaches the app's event stream when logs arrive over HTTP", async () => {
    const tb = await makeRoots({ serve: true });
    cleanup.push(() => tb.close());
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingest([batch([sp])]);
    const res = await fetch(`${tb.url}/api/events`);
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        seen.push(dec.decode(value));
      }
    })();
    await until(() => seen.join("").includes("event: hello"));
    const r = await fetch(`${tb.url}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "test-agent" } }] },
            scopeLogs: [{ scope: { name: "app" }, logRecords: [{ timeUnixNano: "1", eventName: "gen_ai.user.message", body: { kvlistValue: { values: [{ key: "content", value: { stringValue: "hello" } }] } }, traceId: t, spanId: sp.spanId }] }],
          },
        ],
      }),
    });
    expect(r.status).toBe(200);
    await until(() => seen.join("").includes(`"trace_id":"${t}"`));
    await reader.cancel();
    await pump.catch(() => {});
  });

  it("does not announce while the store is closing", async () => {
    const tb: TestRoots = await makeRoots();
    const updates: TraceUpdate[] = [];
    tb.roots.bus.on("trace", (u) => updates.push(u));
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingest([batch([sp])]);
    // More spans than one slice, so some refreshes are still waiting when the store closes.
    const many = Array.from({ length: 250 }, () => llm(hex(16)));
    tb.roots.ingest([batch(many)]);
    updates.length = 0;
    tb.roots.ingestLogs(many.map((m) => log(m.traceId, m.spanId, "gen_ai.user.message", "content", "q")));
    const before = late(updates).length;
    await tb.close();
    expect(late(updates).length).toBe(before);
  });

  it("asks span and trace questions again, with the content that arrived late", async () => {
    const llmServer = await mockLlm();
    const tb = await makeRoots({ llmUrl: llmServer.url });
    cleanup.push(async () => {
      await tb.close();
      await llmServer.close();
    });
    (tb.roots.llm as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => true;
    for (const [id, scope] of [["late-span-q", "span"], ["late-trace-q", "trace"]]) {
      const q = checkFromInput(`
id: ${id}
kind: yes_no
scope: ${scope}
title: ${id}
ask: Did the model answer the user?
flag_at: 0.9
evidence: { spans: { type: [llm] } }
`).check;
      if (!q) throw new Error("question did not parse");
      tb.roots.checks.save(q, "user");
    }
    const engine = tb.roots.engine as unknown as { decisions: { decide: (...a: unknown[]) => Promise<unknown> } };
    const real = engine.decisions.decide.bind(engine.decisions);
    const asked: { check: string; evidence: string }[] = [];
    engine.decisions.decide = async (evidence: unknown, questions: unknown) => {
      const [q] = questions as { name: string }[];
      asked.push({ check: q.name, evidence: String(evidence) });
      return real(evidence, questions);
    };
    const t = hex(16);
    const sp = llm(t);
    tb.roots.ingest([batch([sp])]);
    await until(() => ["late-span-q", "late-trace-q"].every((c) => asked.some((a) => a.check === c)));
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(asked.some((a) => a.evidence.includes("blue giraffe"))).toBe(false);
    const choice = log(t, sp.spanId, "gen_ai.choice", "message", "");
    choice.body = { kvlistValue: { values: [{ key: "message", value: { kvlistValue: { values: [{ key: "role", value: { stringValue: "assistant" } }, { key: "content", value: { stringValue: "the answer is blue giraffe" } }] } } }] } };
    tb.roots.ingestLogs([choice]);
    for (const c of ["late-span-q", "late-trace-q"]) await until(() => asked.some((a) => a.check === c && a.evidence.includes("blue giraffe")));
    // Once with the content, not repeatedly.
    await tb.roots.engine!.waitIdle(t, 5000);
    for (const c of ["late-span-q", "late-trace-q"]) expect(asked.filter((a) => a.check === c && a.evidence.includes("blue giraffe"))).toHaveLength(1);
  });
});
