import type { Span } from "@/lib/api";

type Interval = { start: number; end: number };

/** Parse a bounded decimal OTLP uint64 without losing precision; invalid input returns null. */
function rawTimestamp(value: string): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 20 || /[^0-9]/.test(value)) return null;
  const timestamp = BigInt(value);
  return timestamp <= 18_446_744_073_709_551_615n ? timestamp : null;
}

/** Return completed, valid recorded bounds (including equal bounds), or null for unavailable evidence. */
export function recordedInterval(span: Span): Interval | null {
  const rawStart = span.start_ns === undefined ? undefined : rawTimestamp(span.start_ns);
  const rawEnd = span.end_ns === undefined ? undefined : rawTimestamp(span.end_ns);
  // The store clamps reversed and unfinished intervals to zero milliseconds, retaining raw times.
  if (rawStart === null || rawEnd === null || rawEnd === 0n ||
      (rawStart !== undefined && rawEnd !== undefined && rawEnd < rawStart)) return null;
  if (!Number.isFinite(span.start_ms) || !Number.isFinite(span.end_ms) || span.end_ms < span.start_ms || Math.abs(span.start_ms) > Number.MAX_SAFE_INTEGER || Math.abs(span.end_ms) > Number.MAX_SAFE_INTEGER) return null;
  return { start: span.start_ms, end: span.end_ms };
}
/** Merge overlapping/touching intervals into disjoint copies; sorts the supplied array in place. */
function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}

/**
 * Derive elapsed/outside-child time and leaf-activity gaps from recorded wall-clock evidence.
 * Invalid child timing makes the parent's outside time null; valid zero durations remain zero.
 * Child coverage is clipped and merged; gaps exclude workflow/agent envelopes.
 * No result measures CPU time or proves waiting.
 */
export function analyzeTiming(spans: Span[]) {
  const children = new Map<string, Span[]>();
  for (const span of spans) {
    if (!span.parent_span_id) continue;
    const siblings = children.get(span.parent_span_id) ?? [];
    siblings.push(span);
    children.set(span.parent_span_id, siblings);
  }
  const rows = spans.map((span) => {
    const interval = recordedInterval(span);
    const direct = children.get(span.span_id) ?? [];
    const childIntervals = direct.map(recordedInterval);
    const inconsistent = !!interval && (span.duration_ms !== interval.end - interval.start || childIntervals.some((child) => child && (child.start < interval.start || child.end > interval.end)));
    const covered = interval ? union(childIntervals.flatMap((child) => child ? [{ start: Math.max(interval.start, child.start), end: Math.min(interval.end, child.end) }].filter((x) => x.end >= x.start) : [])).reduce((sum, child) => sum + child.end - child.start, 0) : 0;
    return { span, interval, duration: interval ? interval.end - interval.start : null, outside: interval && childIntervals.every(Boolean) ? Math.max(0, interval.end - interval.start - covered) : null, inconsistent };
  });
  // Leaves represent recorded activity; enclosing workflow/agent spans do not fill gaps.
  const activity = union(rows.filter((row) => !children.has(row.span.span_id) && !["WORKFLOW", "AGENT"].includes(row.span.span_kind)).flatMap((row) => row.interval ? [row.interval] : []));
  const gaps = activity.slice(1).map((interval, index) => ({ start: activity[index].end, end: interval.start }));
  const intervals = rows.flatMap((row) => row.interval ? [row.interval] : []);
  const start = intervals.length ? Math.min(...intervals.map((x) => x.start)) : 0;
  const end = intervals.length ? Math.max(...intervals.map((x) => x.end)) : start;
  return { rows, gaps, start, elapsed: end - start, total: Math.max(1, end - start), incomplete: rows.some((row) => !row.interval) };
}
