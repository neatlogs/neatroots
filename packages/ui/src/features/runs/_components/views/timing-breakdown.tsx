import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Span } from "@/lib/api";
import { dur } from "@/lib/format";
import { analyzeTiming } from "./timeline-analysis";

/** Preserve exact zero as "0 ms" and null as "Unavailable"; positive values use the shared formatter. */
function timing(value: number | null): string {
  return value === null ? "Unavailable" : value === 0 ? "0 ms" : dur(value);
}

/** Show sortable elapsed/outside-child evidence and leaf-activity gaps, with span navigation. */
export function TimingBreakdown({ spans, onSelect }: { spans: Span[]; onSelect: (id: string) => void }) {
  const analysis = useMemo(() => analyzeTiming(spans), [spans]);
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<"duration" | "outside">("duration");
  const [ascending, setAscending] = useState(false);
  const rows = [...analysis.rows].sort((a, b) => {
    const av = a[sort], bv = b[sort];
    return av === null ? (bv === null ? a.span.span_id.localeCompare(b.span.span_id) : 1) : bv === null ? -1 : (ascending ? av - bv : bv - av) || a.span.span_id.localeCompare(b.span.span_id);
  });
  /** Toggle the current column's direction; start a newly selected column longest-first. */
  function changeSort(next: typeof sort) { if (sort === next) setAscending(!ascending); else { setSort(next); setAscending(false); } }
  return <details onToggle={(event) => setOpen(event.currentTarget.open)} className="shrink-0 border-b border-border px-4 py-2 text-xs" data-testid="timing-breakdown">
    <summary className="cursor-pointer font-medium">Timing breakdown</summary>
    {open && <div className="max-h-64 overflow-auto pt-2">
      <p className="text-muted-foreground">Recorded elapsed time outside direct children subtracts their clipped, merged intervals. Child intervals outside the parent are clipped. It is not CPU time or proven waiting.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-96 text-left">
        <thead><tr><th>Span</th>{([['duration', 'Elapsed'], ['outside', 'Outside direct children']] as const).map(([key, label]) => <th key={key} aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'}><Button variant="ghost" size="sm" onClick={() => changeSort(key)}>{label}{sort === key ? (ascending ? ' ↑' : ' ↓') : ''}</Button></th>)}<th>Evidence</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.span.span_id} className="h-8 border-t border-border"><td><Button variant="link" size="sm" onClick={() => onSelect(row.span.span_id)}>{row.span.tool_name ?? row.span.name}</Button></td><td>{timing(row.duration)}</td><td>{timing(row.outside)}</td><td>{!row.interval ? 'Unavailable timing' : row.inconsistent ? 'Inconsistent timing' : row.outside === null ? 'Incomplete child timing' : 'Recorded'}</td></tr>)}</tbody>
      </table></div>
      <p className="mt-2 font-medium">Gaps in recorded activity</p>
      <p className="text-muted-foreground">Between completed leaf calls, excluding workflow and agent spans. Boundaries outside those calls are not counted.{analysis.incomplete ? ' Incomplete timing may hide activity.' : ''}</p>
      {analysis.gaps.length ? <ul>{analysis.gaps.map((gap) => <li key={gap.start}>{timing(gap.start - analysis.start)}–{timing(gap.end - analysis.start)}: {timing(gap.end - gap.start)}</li>)}</ul> : <p>No gaps observed between eligible calls.</p>}
    </div>}
  </details>;
}
