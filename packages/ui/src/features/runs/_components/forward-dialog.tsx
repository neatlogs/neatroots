import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ForwardPreview } from "@/lib/api";

/** Confirms a send to Neatlogs Cloud with the redaction preview in view. */
export function ForwardDialog({
  preview,
  pending,
  onSend,
  onClose,
}: {
  preview: ForwardPreview | undefined;
  pending: boolean;
  onSend: () => Promise<{ status: string; span_count: number; error: string | null }>;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={!!preview}
      onOpenChange={(o) => !o && onClose()}
      title="Send this run to Neatlogs Cloud?"
      confirmLabel="Send run"
      isPending={pending}
      description={
        preview ? (
          <span className="flex flex-col gap-3">
            <span>
              {preview.span_count} spans go to {preview.endpoint} with your API key. The redactions below are applied first, and the send is logged in Settings.
            </span>
            <span className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              {preview.redactions.length === 0
                ? "No emails, phone numbers or keys found to redact."
                : preview.redactions.map((r) => (
                    <span key={r.kind}>
                      Redacting {r.count} × {r.kind.replace("_", " ")}
                      {r.samples[0] && <span className="font-mono"> · e.g. {r.samples[0].sample}</span>}
                    </span>
                  ))}
            </span>
          </span>
        ) : (
          ""
        )
      }
      onConfirm={async () => {
        const r = await onSend().catch((e: Error) => ({ status: "error", span_count: 0, error: e.message }));
        if (r.status === "ok") toast.success(`Sent ${r.span_count} spans to Neatlogs Cloud`);
        else toast.error(`Couldn't send the run to Neatlogs Cloud: ${r.error ?? "unknown error"}. Nothing changed locally; retry from the run.`);
        onClose();
      }}
    />
  );
}
