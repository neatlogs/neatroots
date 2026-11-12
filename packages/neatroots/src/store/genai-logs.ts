import type Database from "better-sqlite3";
import { GENAI_EVENT_NAMES, type GenAiEvent } from "../semantics/genai-events.js";
import { kvToPlain, type KeyValue } from "../otlp/types.js";

/** A stored log's attributes, as OTLP key-values; malformed or missing JSON reads as none. */
function attributes(raw: string | null): KeyValue[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as KeyValue[];
  } catch {
    return [];
  }
}

/** Most events read per span, so a chatty sender cannot make every late-log refresh unbounded work on the event loop. */
export const MAX_LOG_EVENTS = 500;

// One newest-first branch per supported name, each read straight off the (trace_id, span_id, event_name) index and
// stopped at the limit; the outer query keeps the newest overall. Other logs on the span, however many, are never
// read, so they cannot push a supported event out of the window.
export const LOG_EVENTS_SQL = `SELECT event_name, time_ns, body, attributes FROM (${GENAI_EVENT_NAMES.map(
  () => "SELECT * FROM (SELECT id, event_name, time_ns, body, attributes FROM logs WHERE trace_id = ? AND span_id = ? AND event_name = ? AND id < ? ORDER BY id DESC LIMIT ?)",
).join(" UNION ALL ")}) ORDER BY id DESC LIMIT ?`;

/** Binding for {@link LOG_EVENTS_SQL}; `beforeId` keeps only logs stored before that row. */
export function logEventsArgs(traceId: string, spanId: string, beforeId = Number.MAX_SAFE_INTEGER): (string | number)[] {
  return [...GENAI_EVENT_NAMES.flatMap((name) => [traceId, spanId, name, beforeId, MAX_LOG_EVENTS]), MAX_LOG_EVENTS];
}

/**
 * GenAI message events logged against a span (the newest MAX_LOG_EVENTS), oldest first. With `beforeId`, only
 * the ones stored before that log row: what the span showed before a batch of late logs arrived.
 */
export function genAiLogEvents(db: Database.Database, traceId: string, spanId: string, beforeId?: number): GenAiEvent[] {
  const rows = db.prepare(LOG_EVENTS_SQL).all(...logEventsArgs(traceId, spanId, beforeId)) as { event_name: string; time_ns: string | null; body: string | null; attributes: string | null }[];
  return rows
    .reverse()
    .map((r) => ({ name: r.event_name, timeNs: r.time_ns ?? undefined, attributes: kvToPlain(attributes(r.attributes)), body: r.body ?? undefined }));
}
