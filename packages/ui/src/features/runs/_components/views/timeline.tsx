import { CircleIcon, FlashIcon } from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { Span } from "@/lib/api";
import { dur } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isGuidance, KIND_ICON, treeOrder } from "../trace-tree";

const BAR: Record<string, string> = {
  LLM: "bg-brand-violet/70",
  TOOL: "bg-info-fg/70",
  MCP_TOOL: "bg-info-fg/70",
  RETRIEVER: "bg-warning-fg/60",
  EMBEDDING: "bg-warning-fg/60",
  AGENT: "bg-foreground-subtle",
};

function ticks(total: number): number[] {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = steps.find((s) => total / s <= 8) ?? 600_000;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(t);
  return out;
}

/**
 * The run on a time axis, one row per span in tree order: where time went, what ran in
 * parallel, and what waited. Zoom stretches the axis; the box scrolls both ways.
 */
export function TimelineView({ spans, flagged, selected, onSelect }: { spans: Span[]; flagged: Set<string>; selected?: string; onSelect: (id: string) => void }) {
  const rows = useMemo(() => treeOrder(spans), [spans]);
  const [zoom, setZoom] = useState(1);
  if (!rows.length) return <p className="px-6 py-4 text-sm text-muted-foreground">Spans appear here as the agent runs.</p>;
  const start = Math.min(...spans.map((s) => s.start_ms));
  const total = Math.max(1, Math.max(...spans.map((s) => s.end_ms)) - start);
  const marks = ticks(total);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-6 text-xs text-muted-foreground">
        <span className="mr-auto tabular-nums">
          {spans.length} spans · {dur(total)}
        </span>
        <label htmlFor="tl-zoom">Zoom</label>
        <input id="tl-zoom" type="range" min={1} max={8} step={0.5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-foreground" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-full grid-cols-[16rem_minmax(0,1fr)]" style={{ width: `calc(16rem + ${zoom} * (100% - 16rem))` }}>
          <div className="sticky top-0 left-0 z-20 h-7 border-b border-border bg-surface-subtle" />
          <div className="sticky top-0 z-10 h-7 border-b border-border bg-surface-subtle">
            <div className="relative h-full">
              {marks.map((t) => (
                <span key={t} className="absolute top-0 flex h-full items-center pl-1 font-mono text-2xs text-muted-foreground" style={{ left: `${(t / total) * 100}%` }}>
                  {t === 0 ? "0" : dur(t)}
                </span>
              ))}
            </div>
          </div>
          {rows.map(({ span: s, depth }) => {
            const failed = s.status_code === 2;
            const guidance = isGuidance(s);
            const isSel = selected === s.span_id;
            const left = ((s.start_ms - start) / total) * 100;
            const width = Math.max(0.3, (s.duration_ms / total) * 100);
            const rowCls = cn("h-8 cursor-pointer transition-colors", isSel ? "bg-surface-active" : "hover:bg-surface-subtle");
            return (
              <div key={s.span_id} className="contents" onClick={() => onSelect(s.span_id)}>
                <div className={cn(rowCls, "sticky left-0 z-10 flex min-w-0 items-center gap-1.5 border-r border-border bg-background pr-2")} style={{ paddingLeft: 12 + depth * 12 }} title={s.tool_name ?? s.name}>
                  <Icon icon={guidance ? FlashIcon : (KIND_ICON[s.span_kind] ?? CircleIcon)} size="xs" className={cn("shrink-0", failed ? "text-danger-fg" : "text-muted-foreground")} />
                  <span className={cn("truncate text-xs", failed ? "text-danger-fg" : "text-foreground")}>{guidance ? "Note to the agent" : (s.tool_name ?? s.name)}</span>
                  {flagged.has(s.span_id) && <span aria-label="Evidence for an open problem" className="size-1.5 shrink-0 rounded-full bg-warning-fg" />}
                </div>
                <div className={cn(rowCls, "relative")}>
                  {marks.map((t) => (
                    <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${(t / total) * 100}%` }} />
                  ))}
                  <span
                    title={`${s.tool_name ?? s.name} · ${dur(s.duration_ms)} · starts at ${dur(s.start_ms - start)}`}
                    className={cn("absolute top-1/2 h-4 -translate-y-1/2 rounded-sm", failed ? "bg-danger-fg" : guidance ? "bg-brand-violet" : (BAR[s.span_kind] ?? "bg-muted-foreground/40"), isSel && "ring-2 ring-foreground/40")}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  />
                  <span
                    className="absolute top-1/2 -translate-y-1/2 px-1 font-mono text-2xs whitespace-nowrap text-muted-foreground"
                    style={left + width > 85 ? { right: `${100 - left}%` } : { left: `${left + width}%` }}
                  >
                    {dur(s.duration_ms)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
