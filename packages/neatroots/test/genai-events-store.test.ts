import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OtlpLogRecord } from "../src/otlp/codec.js";
import type { OtlpSpan } from "../src/otlp/types.js";
import { LOG_EVENTS_SQL, logEventsArgs } from "../src/store/genai-logs.js";
import { batch, closeTrackedStores, hex, llmSpan, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
const dir = () => {
  const h = tmpHome();
  homes.push(h);
  return path.join(h, "data");
};

const resource = { attributes: [{ key: "service.name", value: { stringValue: "app" } }] };
const userLog = (traceId: string, spanId: string, content: string): OtlpLogRecord => ({
  timeUnixNano: "1",
  eventName: "gen_ai.user.message",
  body: { kvlistValue: { values: [{ key: "content", value: { stringValue: content } }] } },
  attributes: [],
  traceId,
  spanId,
  resource,
  scope: { name: "app" },
});
const bare = (t: string) => span({ traceId: t, name: "chat gpt-4o", kind: "llm", attrs: [s("gen_ai.request.model", "gpt-4o")] });
const lookups = (st: ReturnType<typeof trackedStore>) => {
  const prepare = st.db.prepare.bind(st.db);
  return vi.spyOn(st.db, "prepare").mockImplementation(((sql: string) => prepare(sql)) as typeof st.db.prepare);
};
const logQueries = (spy: ReturnType<typeof lookups>) => spy.mock.calls.filter(([sql]) => String(sql).includes("FROM logs WHERE trace_id")).length;

describe("GenAI log events in the store", () => {
  it("only looks up log events for a span that is missing content or a finish reason", () => {
    const st = trackedStore(dir());
    const spy = lookups(st);
    const full: OtlpSpan = llmSpan(hex(16), "", { system: "sys", user: "q", out: "a" });
    full.attributes.push(s("gen_ai.response.finish_reasons.0", "stop"));
    st.viewOf({ span: full, resource });
    expect(logQueries(spy)).toBe(0);

    st.viewOf({ span: bare(hex(16)), resource });
    expect(logQueries(spy)).toBe(1);

    const noFinish = llmSpan(hex(16), "", { user: "q", out: "a" });
    st.viewOf({ span: noFinish, resource });
    expect(logQueries(spy)).toBe(2);
  });

  it("seeks a span's GenAI events (the full query) without scanning its other logs", () => {
    const st = trackedStore(dir());
    const plan = st.db.prepare(`EXPLAIN QUERY PLAN ${LOG_EVENTS_SQL}`).all(...logEventsArgs("t", "s")) as { detail: string }[];
    const text = plan.map((p) => p.detail).join(" ");
    expect(text).not.toMatch(/SCAN logs/);
    expect(text).toMatch(/logs_span_event \(trace_id=\? AND span_id=\? AND event_name=\?\)/);
  });

  it("adds the logs_span_event index and event_name column to a database created before them", () => {
    const d = dir();
    trackedStore(d).close();
    const raw = new Database(path.join(d, "neatroots.db"));
    raw.exec("DROP INDEX logs_span_event; ALTER TABLE logs DROP COLUMN event_name;");
    raw.close();
    const st = trackedStore(d);
    const idx = st.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='logs_span_event'").all();
    const cols = (st.db.prepare("PRAGMA table_info(logs)").all() as { name: string }[]).map((c) => c.name);
    expect(idx).toHaveLength(1);
    expect(cols).toContain("event_name");
    const plan = st.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM logs WHERE trace_id = ? AND span_id = ? AND event_name >= 'gen_ai.' AND event_name < 'gen_ai/'").all("a", "b") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("logs_span_event");
  });

  it("drops view revisions of deleted runs and keeps the others", () => {
    const st = trackedStore(dir());
    const [a, b] = [hex(16), hex(16)];
    const sa = bare(a);
    const sb = bare(b);
    st.ingest([batch([sa, sb])]);
    st.ingestLogs([userLog(a, sa.spanId, "one"), userLog(b, sb.spanId, "two")]);
    expect(st.viewRevision(a, sa.spanId)).toBe(1);
    expect(st.viewRevision(b, sb.spanId)).toBe(1);
    st.deleteRuns([a]);
    expect(st.viewRevision(a, sa.spanId)).toBe(0);
    expect(st.viewRevision(b, sb.spanId)).toBe(1);
    expect((st as unknown as { viewRevs: Map<string, number> }).viewRevs.size).toBe(1);
  });
});

