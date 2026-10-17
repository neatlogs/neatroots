import { useState } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import type { CheckApprovalRow } from "@/lib/api";
import { pct } from "@/lib/format";
import { useCheckActions, type PreviewResult } from "../_services/check-queries";

/** MCP-authored edits wait here for a person; the current approved version stays active until approval. */
export function McpCheckApprovals({ proposals, userDir }: { proposals: CheckApprovalRow[]; userDir?: string }) {
  const actions = useCheckActions();
  const [previews, setPreviews] = useState<Record<string, PreviewResult>>({});
  const [previewing, setPreviewing] = useState<string>();

  if (!proposals.length) return null;
  return (
    <Panel variant="subtle" className="mx-4 mt-4 sm:mx-6" data-testid="mcp-check-approvals">
      <PanelHeader
        title="Agent checks awaiting approval"
        actions={<StatusPill size="sm" tone="warning">{proposals.length} inactive</StatusPill>}
      />
      <p className="mb-3 text-xs text-muted-foreground">
        These proposals do not run until you approve them. An edit leaves its current active version unchanged.
      </p>
      <PanelContent className="h-96 flex-none overflow-y-auto overscroll-contain divide-y divide-border">
        {proposals.map((proposal) => {
          const preview = previews[proposal.revision];
          return (
            <article key={proposal.id} data-testid="mcp-check-proposal" className="flex h-80 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain py-4">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all text-sm font-medium text-foreground">{proposal.title}</span>
                <span className="font-mono text-2xs text-muted-foreground">{proposal.id}</span>
                <StatusPill size="sm" tone={proposal.has_active_version ? "info" : "muted"}>
                  {proposal.has_active_version ? "Edit · current version stays active" : "Inactive until approval"}
                </StatusPill>
              </div>
              <pre data-testid="proposal-yaml" className="max-h-48 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">{proposal.yaml}</pre>
              <span className="shrink-0 break-all text-2xs text-muted-foreground" title={proposal.target_dir ?? userDir ?? "~/.neatroots/checks"}>
                Approval target: {proposal.target_dir ?? userDir ?? "~/.neatroots/checks"}
              </span>
              {preview && (
                <p role="status" className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground tabular-nums">
                  Fires on {preview.hits.length} of {preview.checked} runs · hit rate {pct(preview.hit_rate)}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <PendingButton
                  size="sm"
                  variant="secondary"
                  pending={previewing === proposal.id}
                  pendingLabel="Previewing…"
                  onClick={() => {
                    setPreviewing(proposal.id);
                    actions.preview.mutate(
                      { yaml: proposal.yaml },
                      {
                        onSuccess: (result) => setPreviews((old) => ({ ...old, [proposal.revision]: result })),
                        onError: (error) => toast.error(`Couldn't preview ${proposal.id}: ${(error as Error).message}`),
                        onSettled: () => setPreviewing(undefined),
                      },
                    );
                  }}
                >
                  Preview check
                </PendingButton>
                <PendingButton
                  size="sm"
                  variant="secondary"
                  pending={actions.approve.isPending && actions.approve.variables?.revision === proposal.revision}
                  pendingLabel="Approving…"
                  onClick={() => actions.approve.mutate({ id: proposal.id, revision: proposal.revision }, {
                    onSuccess: () => toast.success(`Approved ${proposal.id}`),
                    onError: (error) => toast.error(`Couldn't approve ${proposal.id}: ${(error as Error).message}`),
                  })}
                >
                  Approve check
                </PendingButton>
                <PendingButton
                  size="sm"
                  variant="ghost"
                  className="text-danger-fg"
                  pending={actions.reject.isPending && actions.reject.variables?.revision === proposal.revision}
                  pendingLabel="Rejecting…"
                  onClick={() => actions.reject.mutate({ id: proposal.id, revision: proposal.revision }, {
                    onSuccess: () => toast.success(`Rejected ${proposal.id}`),
                    onError: (error) => toast.error(`Couldn't reject ${proposal.id}: ${(error as Error).message}`),
                  })}
                >
                  Reject check
                </PendingButton>
              </div>
            </article>
          );
        })}
      </PanelContent>
    </Panel>
  );
}
