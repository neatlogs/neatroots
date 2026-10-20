import { KpiCard, type KpiDelta } from "@/components/kpi/kpi-card";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import type { Insights } from "@/lib/api";
import { dur, num } from "@/lib/format";
import { cn } from "@/lib/utils";

export const PERIOD: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

const rate = (n: number, d: number) => (d ? n / d : 0);

/** A change against the previous period. `worse` says which direction is bad, if either is. */
function delta(now: number, before: number, opts: { worse?: "up" | "down"; points?: boolean } = {}): KpiDelta {
  const diff = now - before;
  const direction = Math.abs(diff) < 1e-9 ? "flat" : diff > 0 ? "up" : "down";
  const text = opts.points ? `${Math.abs(Math.round(diff * 100))} pts` : before ? `${Math.abs(Math.round((diff / before) * 100))}%` : "new";
  const tone = direction === "flat" || !opts.worse ? "neutral" : (direction === opts.worse ? "bad" : "good");
  return { text, direction, tone };
}

/** Four numbers for the period, each against the period before it, with the period's shape beside it. */
export function Kpis({ data }: { data?: Insights }) {
  const t = data?.totals;
  const p = data?.previous;
  const hadBefore = (p?.runs ?? 0) > 0;
  const period = data ? PERIOD[data.window.key] : "";
  const b = data?.buckets ?? [];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Runs"
        value={t && num(t.runs)}
        comparison={period}
        delta={t && p && hadBefore ? delta(t.runs, p.runs) : undefined}
        footnote="no earlier runs to compare"
        bars={b.map((x) => x.runs)}
      />
      <KpiCard
        label="Runs with problems"
        value={t && `${Math.round(rate(t.with_problems, t.runs) * 100)}%`}
        comparison={period}
        delta={t && p && hadBefore ? delta(rate(t.with_problems, t.runs), rate(p.with_problems, p.runs), { worse: "up", points: true }) : undefined}
        footnote={t ? `${num(t.with_problems)} of ${num(t.runs)} runs` : undefined}
        bars={b.map((x) => x.with_problems)}
      />
      <KpiCard
        label="Failed runs"
        value={t && num(t.failed)}
        comparison={period}
        delta={t && p && hadBefore ? delta(t.failed, p.failed, { worse: "up" }) : undefined}
        footnote={t?.failed ? "ended with an error or were cut off" : "none ended with an error"}
        bars={b.map((x) => x.failed)}
      />
      <KpiCard
        label="Median run"
        value={t && dur(t.p50_ms)}
        comparison={period}
        delta={t && p && hadBefore && t.p50_ms !== null && p.p50_ms !== null ? delta(t.p50_ms, p.p50_ms, { worse: "up" }) : undefined}
        footnote={t?.p95_ms != null ? `95% of runs under ${dur(t.p95_ms)}` : "no finished runs"}
      />
    </div>
  );
}

function bucketLabel(ms: number, hourly: boolean): string {
  const d = new Date(ms);
  return hourly ? d.toLocaleTimeString(undefined, { hour: "numeric" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Runs per hour or day; the part with problems in warning, the rest neutral. */
export function Activity({ data }: { data: Insights }) {
  const hourly = data.window.bucket_ms < 86_400_000;
  const max = Math.max(1, ...data.buckets.map((b) => b.runs));
  const first = data.buckets[0];
  return (
    <Panel>
      <PanelHeader
        title="Runs over time"
        actions={
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-xs bg-warning-fg" />
              with problems
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-xs bg-chart-bar" />
              no problems
            </span>
          </span>
        }
      />
      <PanelContent className="flex flex-col gap-1.5">
        <div role="img" aria-label={`Runs per ${hourly ? "hour" : "day"}`} className="flex h-32 items-end gap-1 border-b border-border">
          {data.buckets.map((b) => {
            const clean = Math.max(0, b.runs - b.with_problems);
            return (
              <div
                key={b.start_ms}
                className="mx-auto flex h-full w-full max-w-10 min-w-0 flex-1 flex-col justify-end"
                title={`${bucketLabel(b.start_ms, hourly)}: ${b.runs} runs, ${b.with_problems} with problems, ${b.failed} failed`}
              >
                {b.with_problems > 0 && <div className="w-full rounded-t-xs bg-warning-fg" style={{ height: `${(b.with_problems / max) * 100}%` }} />}
                {clean > 0 && <div className={cn("w-full bg-chart-bar", b.with_problems === 0 && "rounded-t-xs")} style={{ height: `${(clean / max) * 100}%` }} />}
                {b.runs === 0 && <div className="h-px w-full bg-border" />}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{first && bucketLabel(first.start_ms, hourly)}</span>
          <span>{hourly ? "now" : "today"}</span>
        </div>
      </PanelContent>
    </Panel>
  );
}
