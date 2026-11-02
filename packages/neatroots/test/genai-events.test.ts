import { genAiLogEvents, MAX_LOG_EVENTS } from "../src/store/genai-logs.js";
import { REFRESH_CHUNK } from "../src/store/refresh-queue.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeLogsJson, type OtlpLogRecord } from "../src/otlp/codec.js";
import type { OtlpSpan } from "../src/otlp/types.js";
import { batch, closeTrackedStores, hex, llmSpan, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const store = () => {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
};

const resource = { attributes: [{ key: "service.name", value: { stringValue: "app" } }] };
const scope = { name: "app" };
const log = (traceId: string, spanId: string, eventName: string, body: Record<string, unknown>): OtlpLogRecord => ({
  timeUnixNano: "1",
  eventName,
  body: { kvlistValue: { values: Object.entries(body).map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : { stringValue: JSON.stringify(v) } })) } },
  attributes: [{ key: "gen_ai.system", value: { stringValue: "openai" } }],
  traceId,
  spanId,
  resource,
  scope,
});
const genai = (traceId: string, attrs = [s("gen_ai.request.model", "gpt-4o"), s("gen_ai.system", "openai")]) =>
  span({ traceId, name: "chat gpt-4o", kind: "llm", attrs });
const ev = (name: string, attrs: Record<string, string>) => ({ timeUnixNano: "1", name, attributes: Object.entries(attrs).map(([k, v]) => s(k, v)) });
const previews = (st: ReturnType<typeof store>, t: string, id: string) =>
  st.db.prepare("SELECT input_preview AS i, output_preview AS o FROM spans WHERE trace_id = ? AND span_id = ?").get(t, id) as { i: string | null; o: string | null };
const found = (st: ReturnType<typeof store>, q: string) => (st.db.prepare("SELECT COUNT(*) AS n FROM span_fts WHERE span_fts MATCH ?").get(q) as { n: number }).n;

describe("GenAI message events", () => {
  it("reads the gen_ai.*.message and gen_ai.choice events on a span", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [
      ev("gen_ai.system.message", { content: "You are terse." }),
      ev("gen_ai.user.message", { content: "Where is order 4417?" }),
      ev("gen_ai.choice", { index: "0", finish_reason: "stop", message: JSON.stringify({ role: "assistant", content: "In transit." }) }),
    ];
    st.ingest([batch([sp])]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect(view.input).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Where is order 4417?" },
    ]);
    expect(view.output).toEqual([{ role: "assistant", content: "In transit." }]);
    expect(view.finishReason).toBe("stop");
    expect(previews(st, t, sp.spanId).i).toContain("Where is order 4417?");
    expect(found(st, "4417")).toBe(1);
  });

  it("reads tool calls in an assistant choice and the tool reply in the next call", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [
      ev("gen_ai.user.message", { content: "weather?" }),
      ev("gen_ai.assistant.message", { tool_calls: JSON.stringify([{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }]) }),
      ev("gen_ai.tool.message", { content: "4C", id: "c1" }),
      ev("gen_ai.choice", { index: "0", finish_reason: "tool_calls", message: JSON.stringify({ tool_calls: [{ id: "c2", type: "function", function: { name: "get_time", arguments: "{}" } }] }) }),
    ];
    st.ingest([batch([sp])]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect(view.input).toEqual([
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "get_weather", arguments: { city: "Oslo" } }] },
      { role: "tool", content: "4C", tool_call_id: "c1" },
    ]);
    expect(view.output).toEqual([{ role: "assistant", content: "", tool_calls: [{ id: "c2", name: "get_time", arguments: {} }] }]);
  });

  it("reads gen_ai.client.inference.operation.details and the older content.prompt/completion", () => {
    const st = store();
    const t = hex(16);
    const a = genai(t);
    a.events = [
      ev("gen_ai.client.inference.operation.details", {
        "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hi" }] }]),
        "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "hello" }], finish_reason: "stop" }]),
      }),
    ];
    const b = genai(t);
    b.events = [
      ev("gen_ai.content.prompt", { "gen_ai.prompt": JSON.stringify([{ role: "user", content: "old hi" }]) }),
      ev("gen_ai.content.completion", { "gen_ai.completion": JSON.stringify([{ role: "assistant", content: "old hello" }]) }),
    ];
    st.ingest([batch([a, b])]);
    expect(st.viewOf(st.getOtlpSpan(t, a.spanId)!).input).toEqual([{ role: "user", content: "hi" }]);
    expect(st.viewOf(st.getOtlpSpan(t, a.spanId)!).output).toEqual([{ role: "assistant", content: "hello" }]);
    expect(st.viewOf(st.getOtlpSpan(t, b.spanId)!).input).toEqual([{ role: "user", content: "old hi" }]);
    expect(st.viewOf(st.getOtlpSpan(t, b.spanId)!).output).toEqual([{ role: "assistant", content: "old hello" }]);
  });

  describe("as log records", () => {
    it("keeps the event name when logs are decoded, from event_name or the event.name attribute", () => {
      const rec = (extra: object) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1", body: { stringValue: "x" }, ...extra }] }] }] });
      expect(decodeLogsJson(rec({ eventName: "gen_ai.user.message" }))[0].eventName).toBe("gen_ai.user.message");
      expect(decodeLogsJson(rec({ event_name: "gen_ai.choice" }))[0].eventName).toBe("gen_ai.choice");
      expect(decodeLogsJson(rec({}))[0].eventName).toBeUndefined();
      expect(decodeLogsJson(rec({ eventName: 123 }))[0].eventName).toBeUndefined();
      expect(decodeLogsJson(rec({ eventName: { a: 1 } }))[0].eventName).toBeUndefined();
    });

    it("joins logs that arrive before their span", () => {
      const st = store();
      const t = hex(16);
      const sp = genai(t);
      st.ingestLogs([
        log(t, sp.spanId, "gen_ai.user.message", { content: "refund order 9" }),
        log(t, sp.spanId, "gen_ai.choice", { index: "0", finish_reason: "stop", message: { content: "Refunded." } }),
      ]);
      st.ingest([batch([sp])]);
      const p = previews(st, t, sp.spanId);
      expect(p.i).toContain("refund order 9");
      expect(p.o).toContain("Refunded.");
      expect(found(st, "refund")).toBe(1);
    });

    it("re-derives the span, run and search index when logs arrive after their span", () => {
      const st = store();
      const t = hex(16);
      const sp = genai(t);
      st.ingest([batch([sp])]);
      expect(previews(st, t, sp.spanId)).toEqual({ i: null, o: null });
      st.ingestLogs([
        log(t, sp.spanId, "gen_ai.user.message", { content: "late question" }),
        log(t, sp.spanId, "gen_ai.choice", { index: "0", finish_reason: "stop", message: { content: "late answer" } }),
      ]);
      const p = previews(st, t, sp.spanId);
      expect(p.i).toContain("late question");
      expect(p.o).toContain("late answer");
      expect(st.getRun(t)!.input_preview).toContain("late question");
      expect(found(st, "late")).toBe(1);
    });

    it("ignores logs for other events and logs with no span", () => {
      const st = store();
      const t = hex(16);
      const sp = genai(t);
      st.ingest([batch([sp])]);
      st.ingestLogs([log(t, sp.spanId, "app.audit", { content: "nope" }), log(t, "", "gen_ai.user.message", { content: "nope" })]);
      expect(previews(st, t, sp.spanId)).toEqual({ i: null, o: null });
    });
  });

  it("leaves spans that carry their messages as attributes exactly as before", () => {
    const st = store();
    const t = hex(16);
    const sp: OtlpSpan = llmSpan(t, "", { system: "sys", user: "attr question", out: "attr answer" });
    sp.events = [ev("gen_ai.user.message", { content: "event question" })];
    st.ingest([batch([sp])]);
    st.ingestLogs([log(t, sp.spanId, "gen_ai.user.message", { content: "log question" })]);
    const p = previews(st, t, sp.spanId);
    expect(p.i).toContain("attr question");
    expect(p.i).not.toContain("event question");
    expect(p.i).not.toContain("log question");
    expect(p.o).toContain("attr answer");
  });

  it("takes the finish reason from an event even when the messages are attributes", () => {
    const st = store();
    const t = hex(16);
    const sp: OtlpSpan = llmSpan(t, "", { system: "sys", user: "q", out: "a" });
    sp.events = [ev("gen_ai.choice", { index: "0", finish_reason: "length", message: JSON.stringify({ content: "x" }) })];
    st.ingest([batch([sp])]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect(view.finishReason).toBe("length");
    expect(previews(st, t, sp.spanId).o).toContain("a");
  });

  it("ignores span events named after Object.prototype members", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [ev("toString", { content: "x" }), ev("constructor", { content: "y" }), ev("gen_ai.user.message", { content: "real" })];
    st.ingest([batch([sp])]);
    expect(st.viewOf(st.getOtlpSpan(t, sp.spanId)!).input).toEqual([{ role: "user", content: "real" }]);
  });

  it("reads a span event whose body is JSON in gen_ai.event.content", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [
      ev("gen_ai.user.message", { "gen_ai.event.content": JSON.stringify({ content: "azure question" }) }),
      ev("gen_ai.choice", { "gen_ai.event.content": JSON.stringify({ index: 0, finish_reason: "stop", message: { role: "assistant", content: "azure answer" } }) }),
    ];
    st.ingest([batch([sp])]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect(view.input).toEqual([{ role: "user", content: "azure question" }]);
    expect(view.output).toEqual([{ role: "assistant", content: "azure answer" }]);
    expect(view.finishReason).toBe("stop");
  });

  it("orders span events and log records by when they happened", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [{ ...ev("gen_ai.user.message", { content: "second" }), timeUnixNano: "2000" }];
    st.ingest([batch([sp])]);
    st.ingestLogs([{ ...log(t, sp.spanId, "gen_ai.user.message", { content: "first" }), timeUnixNano: "1000" }, { ...log(t, sp.spanId, "gen_ai.user.message", { content: "third" }), timeUnixNano: "3000" }]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect((view.input as { content: string }[]).map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("keeps span events before log records when an event has no time", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [{ ...ev("gen_ai.user.message", { content: "span" }), timeUnixNano: "0" }];
    st.ingest([batch([sp])]);
    st.ingestLogs([{ ...log(t, sp.spanId, "gen_ai.user.message", { content: "log" }), timeUnixNano: "1000" }]);
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect((view.input as { content: string }[]).map((m) => m.content)).toEqual(["span", "log"]);
  });

  it("reads a bounded number of log records per span, keeping the newest", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    st.ingest([batch([sp])]);
    const recs = Array.from({ length: MAX_LOG_EVENTS + 20 }, (_, i) => ({ ...log(t, sp.spanId, "gen_ai.user.message", { content: `m${i}` }), timeUnixNano: String(1000 + i) }));
    st.ingestLogs(recs);
    const got = genAiLogEvents(st.db, t, sp.spanId);
    expect(got).toHaveLength(MAX_LOG_EVENTS);
    const content = (e: { body?: string }) => (JSON.parse(e.body!) as { content: string }).content;
    expect(content(got[0])).toBe("m20");
    expect(content(got.at(-1)!)).toBe(`m${MAX_LOG_EVENTS + 19}`);
  });

  it("is not crowded out by newer logs that are not GenAI events", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    st.ingest([batch([sp])]);
    st.ingestLogs([{ ...log(t, sp.spanId, "gen_ai.user.message", { content: "keep me" }), timeUnixNano: "1000" }]);
    st.ingestLogs(Array.from({ length: MAX_LOG_EVENTS + 20 }, (_, i) => ({ ...log(t, sp.spanId, "gen_ai.unrecognized", { content: `x${i}` }), timeUnixNano: String(2000 + i) })));
    const view = st.viewOf(st.getOtlpSpan(t, sp.spanId)!);
    expect((view.input as { content: string }[]).map((m) => m.content)).toEqual(["keep me"]);
  });

  it("keeps the newest events of each supported name, not only of the busiest one", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    st.ingest([batch([sp])]);
    st.ingestLogs([
      ...Array.from({ length: MAX_LOG_EVENTS + 5 }, (_, i) => ({ ...log(t, sp.spanId, "gen_ai.user.message", { content: `u${i}` }), timeUnixNano: String(1000 + i) })),
      { ...log(t, sp.spanId, "gen_ai.choice", { index: 0, message: { content: "answer" } }), timeUnixNano: "99999" },
    ]);
    const got = genAiLogEvents(st.db, t, sp.spanId);
    expect(got).toHaveLength(MAX_LOG_EVENTS);
    expect(got.at(-1)!.name).toBe("gen_ai.choice");
  });

  it("refreshes only a bounded slice of spans before ingestion returns, and the rest soon after", async () => {
    const st = store();
    const t = hex(16);
    const spans = Array.from({ length: REFRESH_CHUNK * 2 + 30 }, () => genai(t));
    for (const sp of spans) sp.events = [];
    st.ingest([batch(spans)]);
    const preview = (sp: OtlpSpan) => (st.db.prepare("SELECT input_preview AS p FROM spans WHERE trace_id = ? AND span_id = ?").get(t, sp.spanId) as { p: string | null }).p;
    st.ingestLogs(spans.map((sp) => ({ ...log(t, sp.spanId, "gen_ai.user.message", { content: "late" }), timeUnixNano: "1000" })));

    const done = () => spans.filter((sp) => preview(sp)?.includes("late")).length;
    expect(done()).toBe(REFRESH_CHUNK);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(done()).toBe(spans.length);
  });

  it("applies pending refreshes on flush and on close", () => {
    const st = store();
    const t = hex(16);
    const spans = Array.from({ length: REFRESH_CHUNK + 10 }, () => genai(t));
    for (const sp of spans) sp.events = [];
    st.ingest([batch(spans)]);
    st.ingestLogs(spans.map((sp) => ({ ...log(t, sp.spanId, "gen_ai.user.message", { content: "late" }), timeUnixNano: "1000" })));
    st.flushPendingRefreshes();
    const n = (st.db.prepare("SELECT COUNT(*) AS n FROM spans WHERE trace_id = ? AND input_preview LIKE '%late%'").get(t) as { n: number }).n;
    expect(n).toBe(spans.length);
  });

  it("stores the span itself unchanged, so /v1/traces and the read-back stay lossless", () => {
    const st = store();
    const t = hex(16);
    const sp = genai(t);
    sp.events = [ev("gen_ai.user.message", { content: "keep me" })];
    const before = JSON.stringify(sp);
    st.ingest([batch([sp])]);
    st.ingestLogs([log(t, sp.spanId, "gen_ai.choice", { index: "0", finish_reason: "stop", message: { content: "out" } })]);
    const stored = st.getOtlpSpan(t, sp.spanId)!.span;
    expect(stored.events).toEqual(sp.events);
    expect(stored.attributes).toEqual(sp.attributes);
    expect(JSON.stringify(sp)).toBe(before);
  });
});

it("shows message content logged after the span in the chat the engine builds", async () => {
  const { loadTrace } = await import("../src/engine/trace.js");
  const { buildChat } = await import("../src/semantics/chat-view.js");
  const st = store();
  const t = hex(16);
  const sp = genai(t);
  st.ingest([batch([sp])]);
  expect(buildChat(loadTrace(st, t)).items).toEqual([]);
  st.ingestLogs([log(t, sp.spanId, "gen_ai.user.message", { content: "late q" }), log(t, sp.spanId, "gen_ai.choice", { index: "0", message: { content: "late a" } })]);
  expect(buildChat(loadTrace(st, t)).items.map((i) => i.text)).toEqual(["late q", "late a"]);
});
