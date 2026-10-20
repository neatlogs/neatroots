import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef } from "react";
import { PendingButton } from "@/components/pending-button";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import type { Insights } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWriteDigest } from "../_services/home-queries";

/**
 * The LLM's reading of the numbers on this page: what stands out, in a few sentences. It sees
 * aggregates only, and a sentence quoting a number that is not in the data is dropped.
 */
export function DigestCard({ data, llmOk }: { data: Insights; llmOk: boolean | undefined }) {
  const write = useWriteDigest(data.window.key);
  const asked = useRef<string | null>(null);
  const d = data.digest;
  const pending = write.isPending || data.digest_pending;

  // Write one the first time this period is opened, when there is something to read.
  useEffect(() => {
    if (!d && llmOk && data.totals.runs > 0 && !pending && asked.current !== data.window.key) {
      asked.current = data.window.key;
      write.mutate();
    }
  }, [d, llmOk, data.totals.runs, data.window.key, pending, write]);

  const newRuns = d ? data.totals.runs - d.runs : 0;
  const columns = d
    ? (["bad", "good"] as const)
        .map((tone) => ({ tone, items: d.insights.filter((x) => (tone === "bad" ? x.tone === "bad" : x.tone !== "bad")) }))
        .filter((c) => c.items.length)
    : [];
  return (
    <Panel>
      <PanelHeader
        icon={<Icon icon={AiBrain01Icon} size="xs" className="text-brand-violet" />}
        title="What stands out"
        actions={
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {d && (
              <span className="hidden sm:inline">
                {d.model ?? "LLM"}
                {d.where && d.where !== "local" ? ` (${d.where})` : ""} · {ago(d.created_ms)}
                {newRuns > 0 ? ` · ${newRuns} new run${newRuns === 1 ? "" : "s"} since` : ""}
              </span>
            )}
            {llmOk && data.totals.runs > 0 && (
              <PendingButton size="sm" variant="secondary" pending={pending} pendingLabel="Reading…" onClick={() => write.mutate()}>
                {d ? "Refresh summary" : "Write summary"}
              </PendingButton>
            )}
          </span>
        }
      />
      <PanelContent>
        {d ? (
          <div className={cn("grid gap-6", columns.length > 1 && "md:grid-cols-2")}>
            {columns.map(({ tone, items }) => (
              <div key={tone} className="flex flex-col gap-2">
                <span className="text-eyebrow text-muted-foreground">{tone === "bad" ? "Not working" : "Working"}</span>
                <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {items.map((x, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-foreground">
                      <span aria-hidden className={cn("mt-2 size-1.5 shrink-0 rounded-full", tone === "bad" ? "bg-warning-fg" : "bg-success-fg")} />
                      {x.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="xs" />
            The LLM is reading this period's numbers…
          </p>
        ) : write.isError ? (
          <p className="text-sm text-muted-foreground">Couldn't write a summary: {(write.error as Error).message}</p>
        ) : llmOk === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {llmOk ? "No summary for this period yet." : "With an LLM available, neatroots writes a short summary of what changed. The numbers on this page don't need one."}
          </p>
        )}
      </PanelContent>
    </Panel>
  );
}
