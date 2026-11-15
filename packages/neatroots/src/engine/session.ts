import type { QuestionCheck } from "../checks/types.js";
import type { Store } from "../store/db.js";
import type { SpanRow } from "../types.js";
import { buildEvidence, finalOutput, loadTrace, matchesSelector, type BuiltEvidence, type SpanInfo, type TraceSnapshot } from "./trace.js";

const SESSION_RUN_LOOKBACK = 25;
const SESSION_EARLIER_SPANS = 6;
const SESSION_EARLIER_BUDGET = 2000;

type SessionEvidence = BuiltEvidence & { ownSpanIds: string[] };

/** Select the newest matching metadata first, so discarded spans never load blob payloads. */
function earlierSpans(store: Store, check: QuestionCheck, snap: TraceSnapshot): SpanInfo[] {
  const sessionId = snap.run?.session_id;
  if (!sessionId) return [];
  const startedMs = snap.run?.started_ms;
  const earlier = store.listRuns({
    sessionId,
    excludeStatus: "running",
    limit: SESSION_RUN_LOOKBACK + 1,
    ...(startedMs != null ? { untilMs: startedMs - 1 } : {}),
  }).filter((r) => r.trace_id !== snap.traceId).slice(0, SESSION_RUN_LOOKBACK);
  const selected: { traceId: string; rows: SpanRow[] }[] = [];
  let remaining = SESSION_EARLIER_SPANS;
  for (const run of earlier) {
    const rows = store.getSpans(run.trace_id, false).filter((row) => {
      if (row.name === "neatroots.guidance" || row.name === "roots.guidance") return false;
      return matchesSelector({
        kind: row.span_kind,
        name: row.name,
        toolName: row.tool_name ?? undefined,
        status: row.status_code === 2 ? "error" : row.status_code === 1 ? "ok" : "unset",
      }, check.evidence?.spans);
    }).slice(-remaining);
    selected.push({ traceId: run.trace_id, rows });
    remaining -= rows.length;
    if (!remaining) break;
  }
  const spans: SpanInfo[] = [];
  for (const run of selected.reverse()) {
    if (run.rows.length) spans.push(...loadTrace(store, run.traceId, new Set(run.rows.map((row) => row.span_id))).spans);
  }
  return spans;
}

/** Earlier turns have their own tail and budget; a busy current run cannot crowd them out. */
export function sessionEvidence(store: Store, check: QuestionCheck, snap: TraceSnapshot): SessionEvidence {
  const own = buildEvidence(snap, { ...check.evidence, final_output: false });
  const ev = { ...own, ownSpanIds: [...own.spanIds] };
  const spans = earlierSpans(store, check, snap);
  if (spans.length) {
    const earlier = buildEvidence(
      { traceId: snap.traceId, run: snap.run, spans },
      { spans: check.evidence?.spans, fields: check.evidence?.fields, last: SESSION_EARLIER_SPANS, goal: false },
      { budget: SESSION_EARLIER_BUDGET },
    );
    if (earlier.spanIds.length) {
      ev.text = `Earlier turns in this session:\n${earlier.text}\n\nCurrent run:\n${ev.text}`;
      ev.spanIds = [...earlier.spanIds, ...ev.spanIds];
    }
  }
  return ev;
}

interface SessionRun {
  answered?: { traceChecks: Set<string> };
  traceEvidence: Map<string, string>;
}

/** Keep recovery answers and evidence deduplication synchronous before asking the model. */
export async function askSession(run: SessionRun, check: QuestionCheck, snap: TraceSnapshot, callbacks: {
  evidence: () => SessionEvidence;
  decide: (ev: SessionEvidence) => Promise<"unavailable" | void>;
}): Promise<void> {
  if (run.answered?.traceChecks.has(check.id)) return;
  const ev = callbacks.evidence();
  const out = check.evidence?.final_output ? finalOutput(snap) : undefined;
  if (out) ev.text += `\n\nFinal answer (this run): ${out.length > 1500 ? out.slice(0, 1499) + "…" : out}`;
  if (!ev.ownSpanIds.length && !out) return;
  const key = ev.spanIds.join(",") + (check.evidence?.final_output ? `|${out ?? ""}` : "");
  if (run.traceEvidence.get(check.id) === key) return;
  run.traceEvidence.set(check.id, key);
  const outcome = await callbacks.decide(ev);
  if (outcome === "unavailable" && run.traceEvidence.get(check.id) === key) run.traceEvidence.delete(check.id);
}
