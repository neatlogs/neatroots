import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { ListPageTable } from "@/components/list-page/list-page-layout";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CheckRow } from "@/lib/api";
import { pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CHECK_SOURCE } from "../../runs/_libs/labels";

const HEAD = "h-10 px-3 text-eyebrow font-normal text-muted-foreground";

/** Every check as one row of one height: on or off, what it asks, where it came from, how often it is kept. */
export function ChecksTable({
  checks,
  loading,
  onToggle,
  onOpen,
}: {
  checks: CheckRow[];
  loading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <ListPageTable className="min-w-[48rem] table-fixed">
      <TableHeader className="sticky top-[var(--list-dock-top,0px)] z-[var(--z-sticky)] bg-surface-subtle">
        <TableRow className="border-b border-border hover:bg-transparent">
          <TableHead className={`${HEAD} w-16 pl-6`}>On</TableHead>
          <TableHead className={HEAD}>Check</TableHead>
          <TableHead className={`${HEAD} w-24`}>Kind</TableHead>
          <TableHead className={`${HEAD} w-28`}>Source</TableHead>
          <TableHead className={`${HEAD} w-24`}>Scope</TableHead>
          <TableHead
            className={`${HEAD} w-40 pr-6 text-right`}
            title="Each finding counts once after it is raised or made active. Failed and quiet findings count only if later raised or made active. Older totals are preserved."
          >
            Findings
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && !checks.length
          ? Array.from({ length: 8 }, (_, i) => (
              <TableRow key={i} className="h-12">
                <TableCell colSpan={6} className="px-6">
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))
          : checks.map((c) => {
              const src = CHECK_SOURCE[c.source] ?? CHECK_SOURCE.library;
              return (
                <TableRow key={c.id} className="h-12 cursor-pointer" onClick={() => onOpen(c.id)}>
                  <TableCell className="px-3 pl-6" onClick={(e) => e.stopPropagation()}>
                    <Switch aria-label={`${c.enabled ? "Turn off" : "Turn on"} ${c.id}`} checked={c.enabled} onCheckedChange={(v) => onToggle(c.id, v)} />
                  </TableCell>
                  <TableCell className="px-3">
                    <span className="flex min-w-0 flex-col">
                      <span className={cn("truncate text-sm", c.enabled ? "text-foreground" : "text-muted-foreground")} title={c.title}>
                        {c.title}
                      </span>
                      <span className="truncate font-mono text-2xs text-muted-foreground">{c.id}</span>
                    </span>
                  </TableCell>
                  <TableCell className="px-3 text-sm text-muted-foreground">{c.kind === "rule" ? "rule" : "question"}</TableCell>
                  <TableCell className="px-3">
                    <NeatBadge size="sm" variant={src.variant}>
                      {src.label}
                    </NeatBadge>
                  </TableCell>
                  <TableCell className="px-3 text-sm text-muted-foreground">{typeof c.check.scope === "string" ? c.check.scope : "trace"}</TableCell>
                  <TableCell className="px-3 pr-6 text-right">
                    <span className="inline-flex items-center justify-end gap-2 text-xs text-muted-foreground tabular-nums">
                      {c.precision.noisy && (
                        <StatusPill tone="warning" size="sm">
                          Noisy
                        </StatusPill>
                      )}
                      {c.precision.hits > 0 ? (
                        <span
                          title={`${c.precision.hits} counted findings, ${c.precision.dismissed} dismissed. Findings count once after they are raised or made active; older totals are preserved.`}
                        >
                          {c.precision.hits}
                          {c.precision.precision !== null ? ` · ${pct(c.precision.precision)} kept` : ""}
                        </span>
                      ) : (
                        <span>none</span>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
      </TableBody>
    </ListPageTable>
  );
}
