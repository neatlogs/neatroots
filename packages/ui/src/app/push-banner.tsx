import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { appKeys } from "@/features/runs/_services/run-keys";
import { api, post, type ForwardPreview, type Push } from "@/lib/api";

/** A coding agent asked to push runs to Neatlogs Cloud; nothing is sent until the user confirms here. */
export function PushBanner() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: appKeys.pushes, queryFn: () => api<{ pushes: Push[] }>("/api/pushes") });
  const p = data?.pushes.find((x) => x.status === "pending");
  const preview = useQuery({
    queryKey: ["push-preview", p?.id],
    queryFn: () => post<ForwardPreview>("/api/cloud/preview", { trace_ids: p!.trace_ids }),
    enabled: !!p,
  });
  const act = useMutation({
    mutationFn: (action: "confirm" | "decline") => post<Push>(`/api/pushes/${p!.id}/${action}`),
    onSuccess: (r) => {
      if (r.status === "sent") toast.success("Runs sent to Neatlogs Cloud");
      else if (r.status === "failed") toast.error(`Couldn't send the runs: ${r.error ?? "unknown error"}`);
      else if (r.status === "sending") toast("These runs are already being sent to Neatlogs Cloud");
      else toast("Push declined; nothing was sent");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: appKeys.pushes }),
  });
  if (!p) return null;
  const pv = preview.data;
  const n = p.trace_ids.length;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-info-border bg-info-surface px-6 py-2.5 text-sm">
      <span className="min-w-0 flex-1 text-foreground">
        Your coding agent asked to send {n} run{n > 1 ? "s" : ""} to Neatlogs Cloud.
        {pv && (
          <span className="text-muted-foreground">
            {" "}
            {pv.span_count} spans · {pv.redactions.length ? pv.redactions.map((r) => `${r.count} ${r.kind.replace("_", " ")} redacted`).join(", ") : "nothing to redact"} →{" "}
            {pv.endpoint}
          </span>
        )}
        {pv && !pv.has_key && <span className="text-danger-fg"> · Add an API key in Settings first.</span>}
      </span>
      <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate("decline")}>
        Decline push
      </Button>
      <PendingButton size="sm" pending={act.isPending} disabled={!pv?.has_key} onClick={() => act.mutate("confirm")}>
        Send {n > 1 ? "runs" : "run"} to Cloud
      </PendingButton>
    </div>
  );
}
