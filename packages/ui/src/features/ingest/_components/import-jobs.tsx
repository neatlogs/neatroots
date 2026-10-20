import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill } from "@/components/ui/status-pill";
import { ago } from "@/lib/format";
import { useImportActions, useImportJobs } from "../_services/ingest-queries";

/** Neatlogs Cloud imports running in the background (from here or `neatroots import`), newest first. */
export function ImportJobs() {
  const { data: jobs } = useImportJobs();
  const { cancel } = useImportActions();
  if (!jobs?.jobs.length) return null;
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-4">
        <CardTitle className="font-pixel text-2xs tracking-caps-wide text-muted-foreground uppercase">Imports</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="flex max-h-80 flex-col overflow-y-auto border-t border-border">
          {jobs.jobs.map((j) => (
            <li key={j.id} className="flex min-h-12 items-center gap-3 border-b border-border/60 px-6 py-2 text-sm last:border-0">
              {j.state === "running" ? (
                <Spinner size="xs" />
              ) : (
                <StatusPill size="sm" tone={j.state === "succeeded" ? "success" : j.state === "cancelled" ? "muted" : "danger"}>
                  {j.state === "succeeded" ? "Done" : j.state === "cancelled" ? "Cancelled" : "Failed"}
                </StatusPill>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground tabular-nums">
                  {j.label} · {j.traces} runs, {j.spans} spans{j.skipped ? `, ${j.skipped} already here` : ""}{j.failed ? `, ${j.failed} failed` : ""}
                </span>
                {j.last_error && <span className="truncate text-xs text-danger-fg">{j.last_error}</span>}
              </span>
              {j.state === "running" ? (
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(j.id)}>
                  Cancel import
                </Button>
              ) : j.trace_ids.length ? (
                <a href={`#/runs/${j.trace_ids[0]}`} className="text-xs text-foreground underline-offset-4 hover:underline">
                  Open a run
                </a>
              ) : null}
              <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{ago(j.started_ms)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
