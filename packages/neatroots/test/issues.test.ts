import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodeTraceJson } from "../src/otlp/codec.js";
import { finalOutput, loadTrace, runGoal, runRoot } from "../src/engine/trace.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, s, span, type TestRoots } from "./helpers.js";

// Bad input from outside (#11–#14): a buggy exporter or a script must get a clear error, and one
// odd trace must never break the run page.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function served(): Promise<TestRoots> {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  return tb;
}

const post = (url: string, path: string, body: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("spans whose parents point at each other (#11, #228)", () => {
  it("still serve the conversation, outline, and span context with each span listed once", async () => {
    const tb = await served();
    const t = hex(16);
    const [a, b] = [hex(8), hex(8)];
    tb.roots.ingest([batch([span({ traceId: t, spanId: a, parent: b, name: "agent-a", kind: "agent" }), span({ traceId: t, spanId: b, parent: a, name: "tool-b", kind: "tool" })])]);
    expect((await fetch(`${tb.url}/api/runs/${t}`)).status).toBe(200);
    const chat = await fetch(`${tb.url}/api/runs/${t}/chat`);
    expect(chat.status).toBe(200);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`)));
    const r = (await client.callTool({ name: "get_run_outline", arguments: { trace_id: t } })) as { content: { text: string }[] };
    const outline = JSON.parse(r.content[0].text).outline as string;
    expect(outline.split("\n").filter((l) => l.includes("agent-a") || l.includes("tool-b"))).toHaveLength(2);

    const ctxA = (await client.callTool({ name: "get_span_context", arguments: { trace_id: t, span_id: a } })) as { content: { text: string }[] };
    const parsedCtxA = JSON.parse(ctxA.content[0].text) as { span: { name: string }; ancestors: { name: string }[] };
    expect(parsedCtxA.span.name).toBe("agent-a");
    expect(parsedCtxA.ancestors).toHaveLength(1);
    expect(parsedCtxA.ancestors[0].name).toBe("tool-b");

    const ctxB = (await client.callTool({ name: "get_span_context", arguments: { trace_id: t, span_id: b } })) as { content: { text: string }[] };
    const parsedCtxB = JSON.parse(ctxB.content[0].text) as { span: { name: string }; ancestors: { name: string }[] };
    expect(parsedCtxB.span.name).toBe("tool-b");
    expect(parsedCtxB.ancestors).toHaveLength(1);
    expect(parsedCtxB.ancestors[0].name).toBe("agent-a");

    await client.close();
  });
});

describe("request bodies that aren't a JSON object (#12)", () => {
  it("answer 400 with a message instead of a 500", async () => {
    const tb = await served();
    for (const raw of ["null", "[]", "5", '"x"', "{not json"]) {
      const r = await post(tb.url, "/api/settings", raw);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/JSON/);
    }
    // No body at all still reads as an empty one.
    expect((await fetch(`${tb.url}/api/settings`, { method: "POST" })).status).toBe(200);
  });
});

describe("OTLP JSON whose scopeSpans or spans isn't a list (#13)", () => {
  it("is rejected at every level instead of answering 200 and dropping it", async () => {
    const tb = await served();
    for (const body of [{ resourceSpans: [{ scopeSpans: "x" }] }, { resourceSpans: [{ scopeSpans: [{ spans: "y" }] }] }, { resourceSpans: ["z"] }]) {
      const r = await post(tb.url, "/v1/traces", JSON.stringify(body));
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe(3);
    }
    expect(() => decodeTraceJson({ resourceSpans: [{ scopeSpans: [{ spans: [] }] }] } as never)).not.toThrow();
  });
});

describe("spans without a proper end time (#14)", () => {
  it("a root sent before it ended keeps its run running; it finishes when the ended span arrives", async () => {
    const tb = await served();
    const t = hex(16);
    const root = hex(8);
    const open = span({ traceId: t, spanId: root, name: "agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...open, endTimeUnixNano: "0" }])]);
    const run = tb.roots.store.getRun(t)!;
    expect(run.status).toBe("running");
    expect(run.root_name).toBe("agent");
    expect(tb.roots.store.getSpans(t, false)[0].duration_ms).toBe(0);
    tb.roots.ingest([batch([open])]);
    expect(tb.roots.store.getRun(t)!.status).toBe("ok");
  });

  it("an end before the start never gives a negative duration", async () => {
    const tb = await served();
    const t = hex(16);
    const s = span({ traceId: t, name: "agent", kind: "workflow" });
    tb.roots.ingest([batch([{ ...s, endTimeUnixNano: (BigInt(s.startTimeUnixNano) - 5_000_000_000n).toString() }])]);
    const d = (await (await fetch(`${tb.url}/api/runs/${t}`)).json()) as { run: { duration_ms: number } };
    expect(d.run.duration_ms).toBe(0);
  });
});

describe("a run whose top span has a remote parent (#157)", () => {
  it("ends on that span and reads it as the root", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const remote = hex(8); // the caller's span id, from a propagated traceparent; never sent here
    const root = span({
      traceId: t,
      parent: remote,
      name: "POST /chat",
      kind: "workflow",
      flags: 0x300,
      attrs: [s("neatlogs.session.id", "sess-r"), s("neatlogs.workflow.input", '{"q":"hello"}'), s("neatlogs.workflow.output", '"hi there"')],
    });
    const u = tb.roots.ingest([batch([root, llmSpan(t, root.spanId, { user: "hello", out: "hi there" })])]);
    expect(u[0]).toMatchObject({ runCreated: true, rootEnded: true });
    expect(tb.roots.store.getRun(t)).toMatchObject({
      status: "ok",
      root_span_id: root.spanId,
      root_name: "POST /chat",
      root_ended: 1,
      session_id: "sess-r",
    });
    // The flags survive the round trip, so exports stay exact.
    expect(tb.roots.store.getOtlpSpan(t, root.spanId)!.span.flags).toBe(0x300);
    // The engine reads the same root.
    const snap = loadTrace(tb.roots.store, t);
    expect(runGoal(snap).rootInput).toBe('{"q":"hello"}');
    expect(finalOutput(snap)).toBe("hi there");
  });

  it("stays open when the remote bit is not declared", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    tb.roots.ingest([batch([span({ traceId: t, parent: hex(8), name: "POST /chat", kind: "workflow", flags: 0x200 })])]);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "running", root_name: null, root_ended: 0 });
  });

  it("keeps the caller's span as the root when both processes export to this neatroots", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const caller = span({
      traceId: t,
      name: "caller-agent",
      kind: "workflow",
      attrs: [s("neatlogs.session.id", "sess-caller"), s("neatlogs.workflow.input", '{"q":"hello"}'), s("neatlogs.workflow.output", '"from the caller"')],
    });
    // The caller is still running, so it is exported before it ends, the way a streaming exporter does.
    tb.roots.ingest([batch([{ ...caller, endTimeUnixNano: "0" }])]);
    // The callee got its context from the caller, and that span is in this trace.
    const callee = span({ traceId: t, parent: caller.spanId, name: "tool-service", kind: "workflow", flags: 0x300, attrs: [s("neatlogs.session.id", "sess-callee")] });
    const u = tb.roots.ingest([batch([callee])]);

    // The remote bit alone doesn't make it the top span: the run stays open on the caller's span.
    expect(u[0]).toMatchObject({ rootEnded: false });
    expect(tb.roots.store.getRun(t)).toMatchObject({
      status: "running",
      root_span_id: caller.spanId,
      root_name: "caller-agent",
      root_ended: 0,
      session_id: "sess-caller",
    });
    // The engine reads that root too, not the callee.
    const snap = loadTrace(tb.roots.store, t);
    expect(runRoot(snap.spans)?.id).toBe(caller.spanId);
    expect(runGoal(snap).rootInput).toBe('{"q":"hello"}');
    expect(finalOutput(snap)).toBe("from the caller");

    // It ends when the caller's own span ends.
    tb.roots.ingest([batch([caller])]);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: caller.spanId, root_name: "caller-agent", root_ended: 1 });
  });

  it("does not take a later remote-parent span as the root over the span already there", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const caller = span({ traceId: t, name: "caller-agent", kind: "workflow" });
    tb.roots.ingest([batch([caller])]);
    // A second agent in the trace, parented to an id this trace never receives, arriving late.
    const other = span({ traceId: t, parent: hex(8), name: "tool-service", kind: "workflow", flags: 0x300, status: 2, message: "boom" });
    tb.roots.ingest([batch([other])]);

    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: caller.spanId, root_name: "caller-agent" });
    expect(runRoot(loadTrace(tb.roots.store, t).spans)?.id).toBe(caller.spanId);
  });

  it("reads the parentless span as the root even when a remote-parent span starts first", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const caller = span({ traceId: t, name: "caller-agent", kind: "workflow", attrs: [s("neatlogs.workflow.input", '{"q":"hello"}')] });
    // The callee's clock is two seconds ahead, so it sorts first in the trace even though its parent
    // is right here. The engine reads spans in that order, and must still pick the caller's span.
    const callee = span({ traceId: t, parent: caller.spanId, name: "tool-service", kind: "workflow", flags: 0x300 });
    tb.roots.ingest([batch([caller, { ...callee, startTimeUnixNano: (BigInt(caller.startTimeUnixNano) - 2_000_000_000n).toString() }])]);

    const snap = loadTrace(tb.roots.store, t);
    expect(snap.spans[0].name).toBe("tool-service"); // it does sort first
    expect(runRoot(snap.spans)?.id).toBe(caller.spanId);
    expect(runGoal(snap).rootInput).toBe('{"q":"hello"}');
  });

  it("lets the run's top span name the session, not a child that arrived first", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const remote = hex(8);
    // A child of the caller's span, arriving before it, with a session of its own.
    tb.roots.ingest([batch([span({ traceId: t, parent: remote, name: "tool-service", kind: "tool", attrs: [s("neatlogs.session.id", "sess-child")] })])]);
    expect(tb.roots.store.getRun(t)!.session_id).toBe("sess-child");
    // The top span, whose parent stayed outside the trace, is what the session belongs to.
    tb.roots.ingest([batch([span({ traceId: t, parent: remote, name: "POST /chat", kind: "workflow", flags: 0x300, attrs: [s("neatlogs.session.id", "sess-root")] })])]);

    expect(tb.roots.store.getRun(t)).toMatchObject({ root_name: "POST /chat", session_id: "sess-root" });
  });

  it("reopens the run when the caller's own span arrives open after the callee ended it", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const callerId = hex(8);
    // Exporters that send a span when it ends (the OTel default) deliver the callee before the
    // caller, so at this moment its parent is simply not here yet. It is taken as the top span and
    // the run ends on it, which is the known cost of reading a remote parent (#157).
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_name: "tool-service", root_ended: 1 });

    // The caller's own span arrives still open. It is the real root, and the run is not over: end
    // work ran on the callee's slice of the trace and has to be allowed to run on the full one.
    const callerOpen = span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow", attrs: [s("neatlogs.workflow.input", '{"q":"hello"}')] });
    const u = tb.roots.ingest([batch([{ ...callerOpen, endTimeUnixNano: "0" }])]);

    expect(u[0]).toMatchObject({ rootEnded: false, rootHandedBack: true });
    expect(tb.roots.store.getRun(t)).toMatchObject({
      status: "running",
      root_span_id: callerId,
      root_name: "caller-agent",
      root_ended: 0,
    });
    expect(runRoot(loadTrace(tb.roots.store, t).spans)?.id).toBe(callerId);

    // It ends when the caller's own span ends, and the end is reported again so end-of-run checks
    // and forwarding see the full trace rather than the callee's part of it. The hand-back itself
    // was reported on the update above; by now the root is already the caller's own span.
    const u2 = tb.roots.ingest([batch([callerOpen])]);
    expect(u2[0]).toMatchObject({ rootEnded: true, rootHandedBack: false });
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: callerId, root_name: "caller-agent", root_ended: 1 });
  });

  it("reports the end again when the caller's span arrives already ended", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const callerId = hex(8);
    tb.roots.ingest([batch([span({ traceId: t, parent: callerId, name: "tool-service", kind: "workflow", flags: 0x300 })])]);
    // No open phase this time: the caller's span was buffered and arrives with its own end.
    const u = tb.roots.ingest([batch([span({ traceId: t, spanId: callerId, name: "caller-agent", kind: "workflow" })])]);

    expect(u[0]).toMatchObject({ rootEnded: true, rootHandedBack: true });
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: callerId, root_name: "caller-agent", root_ended: 1 });
  });

  it("does not report a hand-back when the root already had no parent", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    tb.roots.ingest([batch([span({ traceId: t, name: "caller-agent", kind: "workflow" })])]);
    // A second parentless span in the same trace is not a hand-back: nothing was taken from a span
    // that only qualified through its remote parent.
    const u = tb.roots.ingest([batch([span({ traceId: t, name: "another-root", kind: "workflow" })])]);

    expect(u[0]).toMatchObject({ rootEnded: false, rootHandedBack: false });
  });

  it("ends the run when a remote-parent root is sent open first and then with its end", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const remote = hex(8); // the caller's span id, from a propagated traceparent; never sent here
    const root = span({
      traceId: t,
      parent: remote,
      name: "POST /chat",
      kind: "workflow",
      flags: 0x300,
      attrs: [s("neatlogs.workflow.input", '{"q":"hello"}'), s("neatlogs.workflow.output", '"hi there"')],
    });
    // A streaming exporter sends the span open first, then again with its end.
    const u1 = tb.roots.ingest([batch([{ ...root, endTimeUnixNano: "0" }])]);
    expect(u1[0]).toMatchObject({ rootEnded: false });
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "running", root_span_id: root.spanId, root_ended: 0 });

    const u2 = tb.roots.ingest([batch([root])]);
    expect(u2[0]).toMatchObject({ rootEnded: true });
    expect(tb.roots.store.getRun(t)).toMatchObject({ status: "ok", root_span_id: root.spanId, root_name: "POST /chat", root_ended: 1 });
    expect(finalOutput(loadTrace(tb.roots.store, t))).toBe("hi there");
  });

  it("does not report a hand-back for a parentless completion marker", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const remote = hex(8);
    tb.roots.ingest([batch([span({ traceId: t, parent: remote, name: "POST /chat", kind: "workflow", flags: 0x300 })])]);
    const rootId = tb.roots.store.getRun(t)!.root_span_id;

    // A marker with no parent must not read as the caller taking the root back: it doesn't replace
    // the root, so no hand-back is reported and the engine's end bookkeeping stays put.
    const u = tb.roots.ingest([batch([markerSpan(t, "")])]);
    expect(u[0]).toMatchObject({ rootHandedBack: false });
    expect(tb.roots.store.getRun(t)!.root_span_id).toBe(rootId);
  });

  it("counts the run once in its session when the root is delivered twice", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const remote = hex(8);
    const root = span({ traceId: t, parent: remote, name: "POST /chat", kind: "workflow", flags: 0x300, attrs: [s("neatlogs.session.id", "sess-twice")] });
    const sessionCount = () => (tb.roots.store.db.prepare("SELECT run_count FROM sessions WHERE id = ?").get("sess-twice") as { run_count: number }).run_count;
    // Sent open first, then again with its end: the same run joins the session once.
    tb.roots.ingest([batch([{ ...root, endTimeUnixNano: "0" }])]);
    expect(sessionCount()).toBe(1);
    tb.roots.ingest([batch([root])]);
    expect(tb.roots.store.getRun(t)!.session_id).toBe("sess-twice");
    expect(sessionCount()).toBe(1);
  });
});
