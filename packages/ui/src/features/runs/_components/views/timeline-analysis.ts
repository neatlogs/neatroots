import type { Span } from "@/lib/api";

type Interval = { start: number; end: number };
export function recordedInterval(span: Span): Interval | null {
  if (span.end_ns === "0" || !Number.isFinite(span.start_ms) || !Number.isFinite(span.end_ms) || span.end_ms < span.start_ms || Math.abs(span.start_ms) > Number.MAX_SAFE_INTEGER || Math.abs(span.end_ms) > Number.MAX_SAFE_INTEGER) return null;
  return { start: span.start_ms, end: span.end_ms };
}
function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}

/** Recorded wall-clock evidence only; never CPU time or inferred waiting. */
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
