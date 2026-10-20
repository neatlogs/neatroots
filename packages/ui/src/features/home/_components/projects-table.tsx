import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Insights } from "@/lib/api";
import { ago, num } from "@/lib/format";
import { go } from "@/lib/router";

const HEAD = "h-9 px-3 text-eyebrow font-normal text-muted-foreground";

/** One row per project: how much it ran and how often its runs went wrong. */
export function ProjectsTable({ data }: { data: Insights }) {
  if (!data.projects.length) return null;
  return (
    <Panel className="p-0">
      <PanelHeader className="mb-0 px-5 pt-4" title="Projects" actions={<span className="text-xs text-muted-foreground tabular-nums">{data.projects.length}</span>} />
      <PanelContent className="max-h-80 overflow-auto">
        <Table className="min-w-[44rem] table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-surface-subtle">
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className={`${HEAD} w-48 pl-5`}>Project</TableHead>
              <TableHead className={`${HEAD} w-24 text-right`}>Runs</TableHead>
              <TableHead className={`${HEAD} w-44`}>With problems</TableHead>
              <TableHead className={`${HEAD} w-20 text-right`}>Failed</TableHead>
              <TableHead className={HEAD}>Most common problem</TableHead>
              <TableHead className={`${HEAD} w-28 pr-5 text-right`}>Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.projects.map((p) => {
              const share = p.runs ? p.with_problems / p.runs : 0;
              return (
                <TableRow key={p.name} className="h-11 cursor-pointer" onClick={() => go(`runs?project=${encodeURIComponent(p.name)}`)}>
                  <TableCell className="truncate px-3 pl-5 text-sm text-foreground" title={p.name}>
                    {p.name}
                  </TableCell>
                  <TableCell className="px-3 text-right text-sm tabular-nums">{num(p.runs)}</TableCell>
                  <TableCell className="px-3">
                    <span className="flex items-center gap-2 text-sm tabular-nums">
                      <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-warning-fg" style={{ width: `${Math.round(share * 100)}%` }} />
                      </span>
                      <span className="text-muted-foreground">{Math.round(share * 100)}%</span>
                    </span>
                  </TableCell>
                  <TableCell className="px-3 text-right text-sm tabular-nums">
                    {p.failed ? <span className="text-danger-fg">{num(p.failed)}</span> : <span className="text-muted-foreground">0</span>}
                  </TableCell>
                  <TableCell className="truncate px-3 text-sm text-muted-foreground" title={p.top_problem ?? undefined}>
                    {p.top_problem ?? "none"}
                  </TableCell>
                  <TableCell className="px-3 pr-5 text-right font-mono text-xs text-muted-foreground tabular-nums">{ago(p.last_ms)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </PanelContent>
    </Panel>
  );
}
