import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { del } from "@/lib/api";
import { go } from "@/lib/router";
import { runKeys } from "../_services/run-keys";

/** Deletes a run (its spans, findings and notes) from this machine after a confirmation. */
export function DeleteRunDialog({ traceId, open, onOpenChange }: { traceId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => del(`/api/runs/${traceId}`),
    onSuccess: () => {
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: runKeys.lists() });
      toast.success("Run deleted");
      go("runs");
    },
    onError: (e) => toast.error(`Couldn't delete the run: ${(e as Error).message}`),
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this run?"
      description="Its spans, findings and notes are removed from this machine. Runs already sent to Neatlogs Cloud stay there."
      confirmLabel="Delete run"
      destructive
      isPending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}
