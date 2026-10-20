import { Alert02Icon, ArrowRight01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import type { Insights } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Item {
  key: string;
  title: string;
  detail: string;
  trend?: { text: string; tone: "bad" | "good" | "neutral" };
  href?: string;
  mono?: boolean;
}

interface Group {
  label: string;
  items: Item[];
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

function runsTrend(now: number, before: number, hadBefore: boolean): Item["trend"] {
  if (!hadBefore) return undefined;
  if (!before) return { text: "new", tone: "bad" };
  if (now > before) return { text: `up from ${before}`, tone: "bad" };
  if (now < before) return { text: `down from ${before}`, tone: "good" };
  return undefined;
}

function rateTrend(failNow: number, callsNow: number, failBefore: number, callsBefore: number): Item["trend"] {
  if (!callsBefore) return undefined;
  const a = pct(failNow, callsNow);
  const b = pct(failBefore, callsBefore);
  if (a > b) return { text: `up from ${b}%`, tone: "bad" };
  if (a < b) return { text: `down from ${b}%`, tone: "good" };
  return undefined;
}

/** What is going wrong, from whatever checks, tools and models the agents actually used. */
function attention(d: Insights): Group[] {
  const hadBefore = d.previous.runs > 0;
  const multi = d.projects.length > 1;
  return [
    {
      label: "Problems",
      items: d.problems.map((p) => ({
        key: `p:${p.check_id}`,
        title: p.title,
        detail: `in ${p.runs} of ${d.totals.runs} runs${multi ? ` · ${p.projects.join(", ")}` : ""}${p.dismissed ? ` · ${p.dismissed} dismissed as wrong` : ""}`,
        trend: runsTrend(p.runs, p.prev_runs, hadBefore),
        href: `#/runs?check=${encodeURIComponent(p.check_id)}&label=${encodeURIComponent(p.title)}`,
      })),
    },
    {
      label: "Tools",
      items: d.tools
        .filter((t) => t.failures > 0 || t.empty > 0)
        .sort((a, b) => pct(b.failures + b.empty, b.calls) - pct(a.failures + a.empty, a.calls) || b.calls - a.calls)
        .map((t) => ({
          key: `t:${t.name}`,
          title: t.name,
          mono: true,
          detail: [t.failures ? `failed ${t.failures} of ${t.calls} calls (${pct(t.failures, t.calls)}%)` : null, t.empty ? `${t.empty} empty or partial results` : null]
            .filter(Boolean)
            .join(" · "),
          trend: rateTrend(t.failures, t.calls, t.prev_failures, t.prev_calls),
        })),
    },
    {
      label: "Models",
      items: d.models
        .filter((m) => m.errors > 0)
        .map((m) => ({ key: `m:${m.name}`, title: m.name, mono: true, detail: `errors on ${m.errors} of ${m.calls} calls (${pct(m.errors, m.calls)}%)` })),
    },
  ].filter((g) => g.items.length);
}

/** What is holding up, by the same measures. A tool or model needs a few calls before it counts. */
function working(d: Insights): Group[] {
  return [
    {
      label: "Projects",
      items: d.projects
        .filter((p) => p.runs > 0 && p.with_problems === 0 && p.failed === 0)
        .map((p) => ({ key: `pr:${p.name}`, title: p.name, detail: `${p.runs} runs, none with problems`, href: `#/runs?project=${encodeURIComponent(p.name)}` })),
    },
    {
      label: "No longer seen",
      items: d.gone.map((g) => ({ key: `g:${g.check_id}`, title: g.title, detail: `in ${g.prev_runs} runs the period before, none now` })),
    },
    {
      label: "Tools",
      items: d.tools
        .filter((t) => t.failures === 0 && t.empty === 0 && t.calls >= 3)
        .map((t) => ({ key: `t:${t.name}`, title: t.name, mono: true, detail: `${t.calls} calls, all returned data` })),
    },
    {
      label: "Models",
      items: d.models.filter((m) => m.errors === 0 && m.calls >= 3).map((m) => ({ key: `m:${m.name}`, title: m.name, mono: true, detail: `${m.calls} calls, no errors` })),
    },
    {
      label: "Checks that found nothing",
      items: d.passing.map((c) => ({ key: `c:${c.check_id}`, title: c.title, detail: `checked ${c.runs} run${c.runs === 1 ? "" : "s"}` })),
    },
  ].filter((g) => g.items.length);
}

const TREND = { bad: "text-warning-fg", good: "text-success-fg", neutral: "text-muted-foreground" } as const;

/** One line per item, all the same height: what it is, the numbers behind it, and the change. */
function Row({ item, tone }: { item: Item; tone: "bad" | "good" }) {
  const body = (
    <>
      <Icon icon={tone === "bad" ? Alert02Icon : CheckmarkCircle02Icon} size="xs" className={cn("shrink-0", tone === "bad" ? "text-warning-fg" : "text-success-fg")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm text-foreground", item.mono && "font-mono text-xs")} title={item.title}>
          {item.title}
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums" title={item.detail}>
          {item.detail}
        </span>
      </span>
      {item.trend && <span className={cn("shrink-0 text-xs tabular-nums", TREND[item.trend.tone])}>{item.trend.text}</span>}
      {item.href && <Icon icon={ArrowRight01Icon} size="xs" className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
    </>
  );
  const cls = "group flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 last:border-0";
  return item.href ? (
    <a href={item.href} className={cn(cls, "transition-colors hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-none")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A panel of fixed height; its list scrolls inside, so both columns stay the same size. */
function Column({ title, groups, tone, empty }: { title: string; groups: Group[]; tone: "bad" | "good"; empty: string }) {
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  return (
    <Panel className="h-[26rem] p-0">
      <PanelHeader
        className="mb-0 px-5 pt-4"
        title={title}
        actions={total > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{total}</span> : undefined}
      />
      <PanelContent className="overflow-y-auto">
        {total === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">{empty}</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="flex flex-col">
              <span className="sticky top-0 z-10 border-b border-border/60 bg-surface-subtle px-4 py-1.5 text-eyebrow text-muted-foreground">{g.label}</span>
              {g.items.map((it) => (
                <Row key={it.key} item={it} tone={tone} />
              ))}
            </div>
          ))
        )}
      </PanelContent>
    </Panel>
  );
}

export function Health({ data }: { data: Insights }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Column title="Needs attention" groups={attention(data)} tone="bad" empty="Nothing failed and no check found a problem in this period." />
      <Column title="Working well" groups={working(data)} tone="good" empty="Nothing has a clean record yet in this period. Tools and models need a few calls before they count." />
    </div>
  );
}
