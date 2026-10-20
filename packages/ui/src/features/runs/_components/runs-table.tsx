import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ListPageTable } from "@/components/list-page/list-page-layout";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Run } from "@/lib/api";
import { dur, num, stamp } from "@/lib/format";
import { go } from "@/lib/router";
import { runGoal } from "../_libs/labels";
import { RunStatusIcon } from "./run-status-icon";

const HEAD = "h-10 px-3 text-eyebrow font-normal text-muted-foreground";

/** Runs as rows of one height: when, outcome, the request, the top problem and how it ran. */
export function RunsTable({ runs, loading }: { runs: Run[]; loading: boolean }) {
  return (
    <ListPageTable className="min-w-[72rem] table-fixed">
      <TableHeader className="sticky top-[var(--list-dock-top,0px)] z-[var(--z-sticky)] bg-surface-subtle">
        <TableRow className="border-b border-border hover:bg-transparent">
          <TableHead className={`${HEAD} w-40 pl-6`}>Started</TableHead>
          <TableHead className={`${HEAD} w-20 text-center`}>Status</TableHead>
          <TableHead className={HEAD}>Request</TableHead>
          <TableHead className={`${HEAD} w-[22rem]`}>Problems</TableHead>
          <TableHead className={`${HEAD} w-36`}>Workflow</TableHead>
          <TableHead className={`${HEAD} w-20 text-right`}>Spans</TableHead>
          <TableHead className={`${HEAD} w-28 pr-6 text-right`}>Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && !runs.length
          ? Array.from({ length: 8 }, (_, i) => (
              <TableRow key={i} className="h-11">
                <TableCell colSpan={7} className="px-6">
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))
          : runs.map((r) => <RunRow key={r.trace_id} run={r} />)}
      </TableBody>
    </ListPageTable>
  );
}

function RunRow({ run: r }: { run: Run }) {
  const t = stamp(r.started_ms);
  const goal = runGoal(r) ?? r.root_name ?? r.trace_id.slice(0, 8);
  const open = () => go(`runs/${r.trace_id}`);
  return (
    <TableRow className="h-11 cursor-pointer border-b border-border/60" onClick={open}>
      <TableCell className="pl-6 font-mono text-xs whitespace-nowrap text-foreground tabular-nums">
        {t.time} <span className="text-muted-foreground">{t.date}</span>
      </TableCell>
      <TableCell className="text-center">
        <RunStatusIcon status={r.status} />
      </TableCell>
      <TableCell className="truncate">
        <a href={`#/runs/${r.trace_id}`} onClick={(e) => e.stopPropagation()} className="focus-ring truncate rounded-sm text-sm text-foreground" title={goal}>
          {goal}
        </a>
      </TableCell>
      <TableCell className="truncate">
        {r.top_finding ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <NeatBadge variant="amber" className="min-w-0 truncate" title={r.top_finding}>
              <span className="truncate">{r.top_finding}</span>
            </NeatBadge>
            {r.open_finding_count > 1 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">+{r.open_finding_count - 1}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="truncate text-sm text-foreground">{r.workflow ?? "—"}</TableCell>
      <TableCell className="text-right text-sm text-foreground tabular-nums">{num(r.span_count)}</TableCell>
      <TableCell className="pr-6 text-right font-mono text-xs text-foreground tabular-nums">{r.status === "running" ? "running" : dur(r.duration_ms)}</TableCell>
    </TableRow>
  );
}
