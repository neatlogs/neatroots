import { useMutation, useQuery } from "@tanstack/react-query";
import { api, post } from "@/lib/api";
import { PendingButton } from "@/components/pending-button";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";

export interface ReplayBatch {
  id: string;
  times: number;
  state: string;
  linked: number;
  settled: number;
  clean: number;
  pending: number;
  failed: number;
  execution_failed: number;
  evaluation_failed: number;
  unlinked: number;
  cancelled: number;
  error: string | null;
  findings: { check_id: string; count: number; original: boolean }[];
}

export function ReplayBatches({ traceId }: { traceId: string }) {
  const query = useQuery({
    queryKey: ["replay-batches", traceId],
    queryFn: () => api<ReplayBatch[]>(`/api/runs/${traceId}/replay-batches`),
    refetchInterval: 1500,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/api/replay-batches/${id}/cancel`, {}),
    onSuccess: () => void query.refetch(),
  });
  if (query.error) return <p role="alert">Could not load replay batches: {query.error.message}</p>;
  if (!query.data?.length) return null;
  return <Panel data-testid="replay-batches">
    <PanelHeader title="Replay batches" />
    <PanelContent>
      <div className="h-96 space-y-6 overflow-auto">
        {query.data.map((b) => <section key={b.id} className="space-y-2 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{b.times} repeats · <StatusPill size="sm" tone={b.state === "running" ? "info" : b.state === "failed" ? "danger" : "neutral"}>{b.state}</StatusPill></p>
            {b.state === "running" && <PendingButton variant="secondary" size="sm" pending={cancel.isPending} pendingLabel="Cancelling…" onClick={() => cancel.mutate(b.id)}>Cancel remaining repeats</PendingButton>}
          </div>
          <p className="text-xs text-muted-foreground">{b.linked}/{b.times} linked · {b.settled} checked · {b.clean} clean · {b.pending} pending · {b.execution_failed} execution failures · {b.evaluation_failed} check failures · {b.unlinked} unlinked · {b.cancelled} cancelled</p>
          {b.state === "cancelling" && <p className="text-xs">Remaining repeats stopped. Active work may finish.</p>}
          {b.error && <p role="alert" className="text-sm">{b.error}</p>}
          {cancel.error && <p role="alert">Could not cancel: {cancel.error.message}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label="Finding frequency">
              <thead><tr><th className="py-2 pr-3">Check</th><th className="pr-3">Checked repeats</th><th>Original</th></tr></thead>
              <tbody>{b.findings.map((f) => <tr key={f.check_id} className="h-10 border-t border-border"><td className="pr-3 whitespace-nowrap">{f.check_id}</td><td className="pr-3 tabular-nums">{f.count}/{b.settled}</td><td>{f.original ? "Yes" : "No"}</td></tr>)}</tbody>
            </table>
          </div>
          {!b.settled && <p className="text-xs text-muted-foreground">No checked repeats yet; zero findings does not mean clean.</p>}
          <p className="text-xs text-muted-foreground">Frequency counts each check once per checked repeat. Pending checks, failed evaluations and unlinked repeats are excluded. Agent failures still contribute once checked.</p>
          <p className="text-xs text-muted-foreground">Quiet and dismissed findings count as recorded occurrences.</p>
        </section>)}
      </div>
    </PanelContent>
  </Panel>;
}
