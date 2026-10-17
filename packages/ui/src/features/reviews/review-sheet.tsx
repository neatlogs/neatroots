import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";
import { api, post, type SpanDetail } from "@/lib/api";
import { REVIEW_LABELS, VERDICTS, type ReviewItem, type Verdict } from "./types";

export function ReviewSheet({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  // Each opening starts from the saved review, while an open draft keeps its evidence version.
  const { data, error, refetch } = useQuery({ queryKey: ["review", id], queryFn: () => api<ReviewItem>(`/api/reviews/${encodeURIComponent(id)}`), gcTime: 0, refetchOnWindowFocus: false });
  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="shrink-0 border-b border-border px-6 py-4 pr-12">
          <SheetTitle>Review finding</SheetTitle>
          <SheetDescription>Judge the evidence without changing the finding's status.</SheetDescription>
        </SheetHeader>
        {error && <p role="alert" className="p-6 text-sm text-danger-fg">Could not load finding: {error.message}</p>}
        {!data && !error && <p className="p-6 text-sm text-muted-foreground">Loading finding…</p>}
        {data && <ReviewForm item={data} reload={async () => { await refetch({ throwOnError: true }); }} onSaved={onSaved} />}
      </SheetContent>
    </Sheet>
  );
}

function ReviewForm({ item, reload, onSaved }: { item: ReviewItem; reload: () => Promise<void>; onSaved: (id: string) => Promise<void> }) {
  const [verdict, setVerdict] = useState<Verdict | "">(item.review?.verdict ?? "");
  const [reason, setReason] = useState(item.review?.reason ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const qc = useQueryClient();
  const f = item.finding;
  const save = async () => {
    setPending(true); setError("");
    try {
      await post(`/api/reviews/${encodeURIComponent(f.id)}`, { verdict, reason, source: "human", evidence_version: item.evidence_version });
      toast.success("Review saved");
      await qc.invalidateQueries({ queryKey: ["review", f.id] });
      await onSaved(f.id);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        <h2 className="text-sm font-medium break-words">{f.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <NeatBadge>{f.check_kind}</NeatBadge>
          <StatusPill size="sm" tone="neutral">Finding: {f.status}</StatusPill>
          <StatusPill size="sm" tone={item.state === "stale" ? "warning" : "muted"}>{REVIEW_LABELS[item.state]}</StatusPill>
        </div>
        <p className="text-xs break-all text-muted-foreground">{item.project ?? "No project"} · {f.check_id}</p>
        <a className="text-xs underline underline-offset-4" href={`#/runs/${f.trace_id}`} target="_blank" rel="noreferrer">Open run in new tab</a>
        {item.state === "stale" && <p role="status" className="rounded-lg border border-warning-border bg-warning-surface p-3 text-xs text-warning-fg">Evidence or the check changed since the last review. Inspect it again before saving.</p>}
        {typeof f.detail.quote === "string" && <blockquote className="border-l-2 border-border pl-3 text-sm break-words">{f.detail.quote}</blockquote>}
        <Evidence item={item} />
        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <legend className="mb-2 text-sm font-medium">Was this check correct?</legend>
          {Object.entries(VERDICTS).map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name="verdict" value={value} checked={verdict === value} onChange={() => setVerdict(value as Verdict)} />{label}</label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-2 text-sm">Reason (optional)
          <Textarea aria-label="Review reason" maxLength={4000} rows={3} value={reason} disabled={pending} onChange={(e) => setReason(e.target.value)} placeholder="What in the evidence supports your judgment?" />
        </label>
        {item.review && <p className="text-xs text-muted-foreground">Last review: {item.review.source} (self-reported) · {new Date(item.review.updated_ms).toLocaleString()}</p>}
        {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-4">
        <PendingButton size="sm" variant="outline" pending={reloading} disabled={pending} onClick={async () => {
          setReloading(true);
          try { await reload(); await qc.invalidateQueries({ queryKey: ["review-evidence", f.trace_id] }); setError(""); }
          catch (e) { setError((e as Error).message); }
          finally { setReloading(false); }
        }}>Reload evidence</PendingButton>
        <PendingButton size="sm" pending={pending} disabled={!verdict || reloading} pendingLabel="Saving review…" onClick={() => void save()}>Save review and next</PendingButton>
      </div>
    </>
  );
}

function Evidence({ item }: { item: ReviewItem }) {
  const ids = item.finding.evidence_span_ids;
  const [chosen, setChosen] = useState(ids[0] ?? "");
  const id = ids.includes(chosen) ? chosen : ids[0];
  const { data, error } = useQuery({ queryKey: ["review-evidence", item.finding.trace_id, id, item.evidence_version],
    queryFn: () => api<SpanDetail>(`/api/runs/${item.finding.trace_id}/spans/${id}`), enabled: !!id, refetchOnWindowFocus: false });
  return (
    <Panel variant="flat" className="shrink-0">
      <PanelHeader title="Evidence" />
      <PanelContent className="flex flex-col gap-3">
        {ids.length ? <Select value={id} onValueChange={(v) => setChosen(String(v))}>
          <SelectTrigger aria-label="Evidence span" className="w-full min-w-0 font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{ids.map((span) => <SelectItem key={span} value={span}>{span}</SelectItem>)}</SelectContent>
        </Select> : <p className="text-xs text-muted-foreground">No evidence span recorded. Open the run for context.</p>}
        {error && <p role="alert" className="text-xs text-danger-fg">Could not load evidence: {error.message}</p>}
        {id && !data && !error && <p className="text-xs text-muted-foreground">Loading evidence…</p>}
        {data && <div className="flex max-h-72 flex-col gap-3 overflow-auto text-xs" data-testid="review-evidence">
          <span className="font-medium break-all">{data.name}</span>
          {Object.entries({ Input: data.view.input, Output: data.view.output, Error: data.view.error ?? data.status.message }).filter(([, value]) => value !== undefined).map(([label, value]) => (
            <div key={label}><p className="mb-1 text-muted-foreground">{label}</p><pre className="font-mono whitespace-pre-wrap break-all">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>
          ))}
        </div>}
      </PanelContent>
    </Panel>
  );
}
