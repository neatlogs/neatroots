import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, type Status } from "@/lib/api";
import { pct } from "@/lib/format";
import { go } from "@/lib/router";
import { appKeys } from "../../runs/_services/run-keys";
import { useCheckActions, type PreviewResult } from "../_services/check-queries";

const aborted = (e: unknown) => (e as Error)?.name === "AbortError";

function reasonLabel(reason?: string): string {
  switch (reason) {
    case "no_hit": return "Evaluated; no hit";
    case "no_evidence": return "No evidence for this check";
    case "model_error": return "Judge error";
    case "aborted": return "Preview canceled";
    case "time_budget": return "Time limit reached";
    default: return reason?.replaceAll("_", " ") ?? "Not evaluated";
  }
}

function notEvaluatedSummary(skipped: Record<string, number>, errors: Record<string, number>): string {
  const labels: Record<string, string> = {
    no_evidence: "had no evidence",
    model_error: "had a judge error",
    aborted: "were canceled",
    time_budget: "reached the time limit",
  };
  return [
    ...Object.entries(skipped).map(([reason, count]) => `${count} ${labels[reason] ?? reason.replaceAll("_", " ")}`),
    ...Object.entries(errors).map(([reason, count]) => `${count} ${labels[reason] ?? reason.replaceAll("_", " ")}`),
  ].join(", ");
}

/** Write a check: describe it, let the LLM draft the YAML, preview it on recent runs, save. */
export function CheckEditor({ open, initialYaml, userDir, onClose }: { open: boolean; initialYaml: string; userDir?: string; onClose: () => void }) {
  const a = useCheckActions();
  const [concern, setConcern] = useState("");
  const [yaml, setYaml] = useState(initialYaml);
  const [preview, setPreview] = useState<PreviewResult>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const ctrl = useRef<AbortController | null>(null);
  const waiting = a.draft.isPending || a.preview.isPending;
  const { data: status } = useQuery({ queryKey: appKeys.status, queryFn: () => api<Status>("/api/status"), enabled: open, refetchInterval: waiting ? 3000 : false });
  const busy = Math.max(0, (status?.engine?.llm.busy ?? 0) - 1);
  const hitsByRun = new Map((preview?.hits ?? []).map((hit) => [hit.trace_id, hit]));
  const notEvaluated = preview ? Object.values(preview.skipped).reduce((sum, count) => sum + count, 0) + Object.values(preview.errors).reduce((sum, count) => sum + count, 0) : 0;
  const start = () => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    return ctrl.current.signal;
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="gap-1 border-b border-border px-6 py-4 pr-12">
          <SheetTitle className="text-base font-normal">{initialYaml ? "Edit a copy" : "New check"}</SheetTitle>
          <SheetDescription className="text-xs">
            Saved to <span className="font-mono">{userDir ?? "~/.neatroots/checks"}</span>. To share checks with your team, run <span className="font-mono">neatroots init</span> in
            your repo.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <Field>
            <FieldLabel htmlFor="concern">Describe a problem in plain language</FieldLabel>
            <Textarea
              id="concern"
              rows={3}
              placeholder="The agent refunds without checking the customer owns the order"
              value={concern}
              onChange={(e) => setConcern(e.target.value)}
            />
            <div>
              <PendingButton
                variant="secondary"
                disabled={concern.trim().length < 8}
                pending={a.draft.isPending}
                pendingLabel="Drafting…"
                onClick={() =>
                  a.draft.mutate(
                    { concern, signal: start() },
                    {
                      onSuccess: (r) => {
                        setYaml(r.yaml);
                        setPreview(undefined);
                        setWarnings(r.warnings ?? []);
                      },
                      onError: (e) => !aborted(e) && toast.error(`Couldn't draft the check: ${(e as Error).message}. Your description is still here.`),
                    },
                  )
                }
              >
                Draft check
              </PendingButton>
              {a.draft.isPending && (
                <Button variant="ghost" size="sm" className="ml-2" onClick={() => ctrl.current?.abort()}>
                  Cancel draft
                </Button>
              )}
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="check-yaml">Check (YAML)</FieldLabel>
            <Textarea
              id="check-yaml"
              rows={14}
              className="h-72 resize-none font-mono text-xs"
              value={yaml}
              onChange={(e) => {
                setYaml(e.target.value);
                setWarnings([]);
              }}
              placeholder={"id: my-check\nkind: yes_no\nscope: trace\nask: Did the agent ...?\nflag_at: 0.8"}
            />
          </Field>
          {waiting && busy > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              The model is also working through {busy} background check{busy === 1 ? "" : "s"}; yours goes first.
            </p>
          )}
          {warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-warning-border bg-warning-surface px-3 py-2.5 text-xs text-foreground" role="status">
              {warnings.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
          )}
          {preview && (
            <div className="flex flex-col gap-1.5 rounded-lg bg-surface-subtle px-3 py-2.5">
              <span className="text-sm text-foreground tabular-nums">
                Fires on {preview.hits.length} of {preview.checked} evaluated runs · hit rate {pct(preview.hit_rate)}
                {preview.truncated ? ` (stopped early; ${preview.total} available)` : ""}
              </span>
              {notEvaluated > 0 && (
                <span className="text-xs text-muted-foreground">
                  {notEvaluated} of {preview.total} runs were not evaluated: {notEvaluatedSummary(preview.skipped, preview.errors)}.
                </span>
              )}
              {preview.checked > 0 && preview.hits.length === 0 && (
                <span className="text-xs text-muted-foreground">It did not fire on the evaluated runs. If you expected a hit, check that the evidence includes what the question asks about.</span>
              )}
              <div className="flex max-h-40 flex-col overflow-y-auto">
                {preview.results.map((result) => {
                  const hit = hitsByRun.get(result.trace_id);
                  const label = result.status === "hit"
                    ? "Fired"
                    : reasonLabel(result.reason);
                  return (
                  <button
                    key={result.trace_id}
                    type="button"
                    aria-label={`${result.root_name ?? result.trace_id}: ${label}`}
                    onClick={() => go(`runs/${result.trace_id}`)}
                    className="flex h-7 shrink-0 cursor-pointer items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    <span className="font-mono">{result.trace_id.slice(0, 8)}</span>
                    <span className="truncate">{result.root_name ?? "Run"}</span>
                    <span className="ml-auto max-w-[48%] truncate" title={label}>{label}</span>
                    {hit?.probability !== null && hit?.probability !== undefined && <span className="tabular-nums">{pct(hit.probability)}</span>}
                  </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          {a.preview.isPending && (
            <Button variant="ghost" onClick={() => ctrl.current?.abort()}>
              Cancel preview
            </Button>
          )}
          <PendingButton
            variant="secondary"
            disabled={!yaml}
            pending={a.preview.isPending}
            pendingLabel="Previewing…"
            onClick={() =>
              a.preview.mutate(
                { yaml, signal: start() },
                {
                  onSuccess: (r) => {
                    setPreview(r);
                    setWarnings(r.warnings ?? []);
                  },
                  onError: (e) => !aborted(e) && toast.error(`Couldn't preview the check: ${(e as Error).message}`),
                },
              )
            }
          >
            Preview on recent runs
          </PendingButton>
          <PendingButton
            disabled={!yaml}
            pending={a.save.isPending}
            onClick={() =>
              a.save.mutate(yaml, {
                onSuccess: (r) => {
                  toast.success(`Saved ${r.id} to ${r.path}`);
                  onClose();
                },
                onError: (e) => toast.error(`Couldn't save the check: ${(e as Error).message}. Your YAML is still in the editor.`),
              })
            }
          >
            Save check
          </PendingButton>
        </div>
      </SheetContent>
    </Sheet>
  );
}
