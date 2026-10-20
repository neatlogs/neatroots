import { ArrowDown01Icon, ArrowRight01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { KPIBars } from "./kpi-bars";

// The Neatlogs Analytics KPI card: label, large value and a "vs last period" pill on the left,
// a bar mini-chart on the right. Colour comes from the badge tokens.

export type KpiTone = "good" | "bad" | "neutral";

const TONE_PILL: Record<KpiTone, string> = {
  good: "bg-badge-green-bg text-badge-green-text",
  bad: "bg-badge-red-bg text-badge-red-text",
  neutral: "bg-muted/50 text-muted-foreground",
};

const TONE_BAR: Record<KpiTone, string> = {
  good: "var(--color-badge-green-text)",
  bad: "var(--color-badge-red-text)",
  neutral: "var(--chart-1)",
};

export interface KpiDelta {
  /** Shown in the pill, e.g. "12%" or "4 pts". */
  text: string;
  direction: "up" | "down" | "flat";
  tone: KpiTone;
}

export function KpiCard({
  label,
  value,
  delta,
  comparison,
  bars,
  footnote,
}: {
  label: string;
  value?: string;
  delta?: KpiDelta;
  /** e.g. "7 days": rendered "vs last 7 days". */
  comparison: string;
  bars?: number[];
  /** Replaces the comparison row when there is nothing to compare with. */
  footnote?: string;
}) {
  if (value === undefined) {
    return (
      <div className="flex h-full w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-10 w-16 rounded-md" />
      </div>
    );
  }
  const tone = delta?.tone ?? "neutral";
  const DeltaIcon = delta?.direction === "up" ? ArrowUp01Icon : delta?.direction === "down" ? ArrowDown01Icon : ArrowRight01Icon;
  return (
    <div className="flex h-full w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate text-xs font-medium text-foreground/80">{label}</span>
        <span className="min-w-0 truncate font-pixel text-2xl leading-none font-medium text-foreground tabular-nums [font-variant-numeric:tabular-nums_slashed-zero]">
          {value}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          {delta ? (
            <>
              <span className="shrink-0 text-2xs leading-none text-muted-foreground/80">vs last {comparison}</span>
              <span className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-2xs leading-none font-medium tabular-nums", TONE_PILL[tone])}>
                <Icon className="shrink-0" icon={DeltaIcon} size="xs" />
                {delta.text}
              </span>
            </>
          ) : (
            <span className="truncate text-2xs leading-4 text-muted-foreground/80">{footnote}</span>
          )}
        </div>
      </div>
      {bars && bars.some((b) => b > 0) && <KPIBars className="text-foreground" color={TONE_BAR[tone]} data={bars} />}
    </div>
  );
}
