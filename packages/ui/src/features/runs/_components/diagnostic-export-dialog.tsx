import { Download01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";

interface ExportPayload {
  bundle: {
    redactions: { matches: { kind: string; count: number }[] };
    [key: string]: unknown;
  };
  preview: { span_count: number; finding_count: number; check_count: number };
}
const PREVIEW_CHARACTERS = 32 * 1024;

export function DiagnosticExportDialog({ traceId, open, onOpenChange }: { traceId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [payload, setPayload] = useState<ExportPayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // The server refuses oversized exports before hydration and caps the JSON response.
  // Keep download bytes complete; render at most 32 Ki characters in the DOM.
  const content = useMemo(() => (payload ? JSON.stringify(payload.bundle) : ""), [payload]);
  const preview = content.slice(0, PREVIEW_CHARACTERS);

  useEffect(() => {
    if (!open) {
      setPayload(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setPayload(undefined);
    setError(undefined);
    setLoading(true);
    api<ExportPayload>(`/api/runs/${encodeURIComponent(traceId)}/diagnostic-export`, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setPayload(next);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted && cause.name !== "AbortError") setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [traceId, open]);

  const download = () => {
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    // Filename metadata must not reveal identifiers omitted or aliased in the bundle.
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    link.download = `neatroots-diagnostic-${token}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-4xl grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-3 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:gap-4 sm:p-6">
        <DialogHeader className="min-w-0 text-left">
          <DialogTitle>Prepare diagnostic export</DialogTitle>
          <DialogDescription className="min-w-0 max-w-3xl text-left leading-relaxed">
            This local JSON retains redacted traces, library checks and metadata. Unverifiable check bodies, generated text and answers are omitted. Only user-created plan parameter values are included, with redaction. Check IDs use opaque aliases. Matching trace/span IDs also use aliases; matching OTLP integers and times become zero. Nothing is uploaded. Patterns may miss sensitive values. Limits: 2 MiB source data and 4 MiB JSON.
          </DialogDescription>
        </DialogHeader>

        {payload ? (
          <div className="grid min-w-0 grid-cols-[repeat(3,minmax(0,1fr))] gap-2" aria-label="Export contents">
            <div className="min-w-0 rounded-md border border-border bg-surface-subtle px-3 py-2">
              <div className="text-lg tabular-nums">{payload.preview.span_count}</div>
              <div className="text-xs text-muted-foreground">spans</div>
            </div>
            <div className="min-w-0 rounded-md border border-border bg-surface-subtle px-3 py-2">
              <div className="text-lg tabular-nums">{payload.preview.finding_count}</div>
              <div className="text-xs text-muted-foreground">findings</div>
            </div>
            <div className="min-w-0 rounded-md border border-border bg-surface-subtle px-3 py-2">
              <div className="text-lg tabular-nums">{payload.preview.check_count}</div>
              <div className="text-xs text-muted-foreground">relevant checks</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" role={error ? "alert" : "status"}>
            {error ? `Couldn't prepare this export: ${error}` : loading ? "Preparing a redacted copy on this machine…" : "Preparing export…"}
          </p>
        )}

        {payload && (
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" aria-live="polite">
              <span className="min-w-0">
                {payload.bundle.redactions.matches.length
                  ? payload.bundle.redactions.matches.map((match) => `${match.count} × ${match.kind.replaceAll("_", " ")}`).join(" · ")
                  : "No matches for the configured patterns."}
              </span>
              <span>Redaction counts only; no sample values are shown.</span>
            </div>
            <ScrollArea
              aria-label="Sanitized diagnostic bundle JSON preview"
              className="h-[min(46vh,30rem)] min-h-44 min-w-0 rounded-lg border border-border bg-muted/40"
              viewportClassName="h-full overscroll-contain"
            >
              <pre data-testid="diagnostic-export-preview" className="min-w-0 max-w-full p-4 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-foreground">
                {preview}
              </pre>
            </ScrollArea>
            {preview.length < content.length && (
              <p className="text-xs text-muted-foreground" role="status">Preview shows the first 32 Ki characters. Download contains the complete sanitized bundle.</p>
            )}
          </div>
        )}

        <DialogFooter className="w-full min-w-0 gap-2 sm:gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={download} disabled={!payload || !!error}>
            <Icon icon={Download01Icon} size="xs" />
            Download diagnostic bundle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
