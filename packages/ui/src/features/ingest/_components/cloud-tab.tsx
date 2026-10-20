import { CloudDownloadIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Status } from "@/lib/api";
import { dur, num, stamp } from "@/lib/format";
import { go } from "@/lib/router";
import { useCloudTraces, useImportActions } from "../_services/ingest-queries";
import { ImportJobs } from "./import-jobs";

const HEAD = "h-9 px-3 text-eyebrow font-normal text-muted-foreground";

/** Recent Neatlogs Cloud traces; import one to debug a production run on this machine. */
export function CloudTab({ status }: { status?: Status }) {
  const hasToken = !!status?.cloud.has_token;
  const { data, error, isLoading } = useCloudTraces(hasToken);
  const { cloud } = useImportActions();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  if (!hasToken) {
    return (
      <EmptyState
        variant="bordered"
        icon={CloudDownloadIcon}
        title="Connect Neatlogs Cloud"
        description="Importing reads Neatlogs Cloud with a service-account token (nlsa_…), not the project API key that sends runs. Add one and choose its project, and recent production traces show up here to explain, check and replay locally."
        action={
          <Button size="sm" variant="secondary" onClick={() => go("settings/cloud")}>
            Add token
          </Button>
        }
      />
    );
  }
  if (error) return <EmptyState variant="bordered" state="error" title="Couldn't reach Neatlogs Cloud" description={(error as Error).message} />;
  const traces = data?.traces ?? [];
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">The newest traces in your Neatlogs Cloud project.</span>
        <PendingButton className="ml-auto" size="sm" disabled={!picked.size} pending={cloud.isPending} onClick={() => cloud.mutate([...picked], { onSuccess: () => setPicked(new Set()) })}>
          Import {picked.size || ""} selected
        </PendingButton>
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-xl border border-border">
        <Table className="min-w-[48rem] table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-surface-subtle">
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className={`${HEAD} w-10 pl-4`} />
              <TableHead className={`${HEAD} w-40`}>Started</TableHead>
              <TableHead className={HEAD}>Trace</TableHead>
              <TableHead className={`${HEAD} w-24`}>Status</TableHead>
              <TableHead className={`${HEAD} w-20 text-right`}>Spans</TableHead>
              <TableHead className={`${HEAD} w-24 text-right`}>Tokens</TableHead>
              <TableHead className={`${HEAD} w-24 pr-4 text-right`}>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i} className="h-11">
                    <TableCell colSpan={7} className="px-4">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : traces.map((t) => {
                  const ts = stamp(Date.parse(t.startedAt));
                  return (
                    <TableRow key={t.traceId} className="h-11 cursor-pointer" onClick={() => (t.local ? go(`runs/${t.traceId}`) : toggle(t.traceId))}>
                      <TableCell className="px-3 pl-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox aria-label={`Select ${t.traceId}`} disabled={t.local} checked={picked.has(t.traceId)} onCheckedChange={() => toggle(t.traceId)} />
                      </TableCell>
                      <TableCell className="px-3 font-mono text-xs text-muted-foreground tabular-nums">
                        {ts.time} {ts.date}
                      </TableCell>
                      <TableCell className="px-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm text-foreground">{t.traceName ?? t.workflowName ?? t.traceId}</span>
                          {t.local && (
                            <StatusPill size="sm" tone="success">
                              Here
                            </StatusPill>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 text-xs text-muted-foreground">{t.status ?? ""}</TableCell>
                      <TableCell className="px-3 text-right text-sm tabular-nums">{num(t.spansCount ?? null)}</TableCell>
                      <TableCell className="px-3 text-right text-sm tabular-nums">{num(t.totalTokens ?? null)}</TableCell>
                      <TableCell className="px-3 pr-4 text-right font-mono text-xs text-muted-foreground">{dur(t.durationMs ?? null)}</TableCell>
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
        {!isLoading && !traces.length && <p className="px-4 py-6 text-sm text-muted-foreground">No traces in this project yet.</p>}
      </div>
      <ImportJobs />
    </div>
  );
}
