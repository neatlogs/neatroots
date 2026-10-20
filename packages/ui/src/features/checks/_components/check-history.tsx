import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { api } from "@/lib/api";

interface HistoryPage { total: number; limit: number; offset: number; truncated: boolean }

function HistoryPages({ page, onPage }: { page: HistoryPage | undefined; onPage: (offset: number) => void }) {
  if (!page || (page.offset === 0 && !page.truncated)) return null;
  return <div className="flex items-center gap-2 text-xs text-muted-foreground">
    <span>Showing {page.offset + 1}–{Math.min(page.total, page.offset + page.limit)} of {page.total}</span>
    <Button variant="ghost" size="sm" disabled={page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>Previous page</Button>
    <Button variant="ghost" size="sm" disabled={!page.truncated} onClick={() => onPage(page.offset + page.limit)}>Next page</Button>
  </div>;
}

interface Revision { id: string; active: number; first_seen_ms: number; definition: unknown }
interface Evaluation {
  id: string; check_id: string; revision_id: string; backend: string; model: string | null;
  decision_id: string | null; finding_id: string | null;
  snapshot: { question: unknown; params: unknown; evidence_sha256: string; evidence_span_ids: string[]; revision: { definition: unknown } };
  execution_settings: unknown;
}

export function CheckHistory({ checkId }: { checkId: string }) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [checkId]);
  const query = useQuery({ queryKey: ["check-history", checkId, offset], queryFn: () => api<HistoryPage & { revisions: Revision[] }>(`/api/checks/${encodeURIComponent(checkId)}/history?offset=${offset}`), refetchInterval: 5000 });
  return <section aria-label="Check history" className="space-y-2">
    <h3 className="text-sm font-medium">Definition history</h3>
    <p className="text-xs text-muted-foreground">Read-only definitions. History does not grant approval or model trust.</p>
    <div className="h-64 overflow-y-auto rounded-lg border border-border p-3">
      {query.isPending ? <p className="text-xs text-muted-foreground">Loading history…</p> : query.error ? <p className="text-xs text-danger-fg">Could not load history</p> : !query.data?.revisions.length ? <p className="text-xs text-muted-foreground">No recorded revisions</p> : query.data.revisions.map((r) => <details key={r.id} className="border-b border-border py-2 last:border-0">
        <summary className="cursor-pointer break-all font-mono text-xs">{r.active ? "Active · " : "Previous · "}{r.id.slice(0, 12)} · {new Date(r.first_seen_ms).toLocaleString()}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(r.definition, null, 2)}</pre>
      </details>)}
    </div>
    <HistoryPages page={query.data} onPage={setOffset} />
  </section>;
}

export function RunCheckHistory({ traceId }: { traceId: string }) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [traceId]);
  const query = useQuery({ queryKey: ["run-check-history", traceId, offset], queryFn: () => api<HistoryPage & { evaluations: Evaluation[] }>(`/api/runs/${encodeURIComponent(traceId)}/check-history?offset=${offset}`), refetchInterval: 5000 });
  return <Panel data-testid="check-provenance">
    <PanelHeader title="Check provenance" />
    <PanelContent>
      <p className="mb-3 text-xs text-muted-foreground">Recorded evaluations are read-only. Earlier verdicts without a record have unknown provenance.</p>
      <div className="h-64 overflow-y-auto">
        {query.error ? <EmptyState variant="inline" state="error" title="Could not load provenance" /> : query.isPending ? <p className="text-xs text-muted-foreground">Loading provenance…</p> : !query.data?.evaluations.length ? <p className="text-xs text-muted-foreground">No recorded provenance. Legacy provenance is unknown.</p> : query.data.evaluations.map((e) => <details key={e.id} className="border-b border-border py-2 last:border-0">
          <summary className="cursor-pointer break-all text-xs">{e.check_id} · {e.revision_id.slice(0, 12)} · {e.backend} · {e.model ?? "model unknown"}</summary>
          <dl className="my-2 space-y-1 break-all text-xs text-muted-foreground">
            <div>Decision: {e.decision_id ?? "none (rule or failed evaluation)"}</div>
            <div>Finding: {e.finding_id ?? "none"}</div>
            <div>Evidence SHA-256: {e.snapshot.evidence_sha256}</div>
            <div>Evidence spans: {e.snapshot.evidence_span_ids.join(", ") || "none"}</div>
          </dl>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify({ question: e.snapshot.question, params: e.snapshot.params, definition: e.snapshot.revision.definition, execution: e.execution_settings }, null, 2)}</pre>
        </details>)}
      </div>
      <HistoryPages page={query.data} onPage={setOffset} />
    </PanelContent>
  </Panel>;
}
