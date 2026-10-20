import { useState } from "react";
import { toast } from "sonner";
import { NeatBadge } from "@/components/neat-ui/neat-badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui/status-pill";
import type { Annotation, Finding } from "@/lib/api";
import { dur, midId, num } from "@/lib/format";
import { spanKindBadge } from "../_libs/labels";
import { useRunActions, useSpanDetail } from "../_services/run-queries";
import { MessageList } from "./message-list";

function KeyValues({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,38%)_1fr] font-mono text-xs">
      {entries.map(([k, v]) => {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return (
          <div key={k} className="contents">
            <dt className="truncate border-b border-border py-1.5 pr-3 text-muted-foreground" title={k}>
              {k}
            </dt>
            <dd className="border-b border-border py-1.5 break-all text-foreground">{s.length > 3000 ? `${s.slice(0, 3000)}… (${s.length.toLocaleString()} characters)` : s}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One span in a side sheet: why it matters, what went in and what came out. The body scrolls. */
export function SpanSheet({
  traceId,
  spanId,
  findings,
  annotations,
  onClose,
  onReplay,
}: {
  traceId: string;
  spanId: string | undefined;
  findings: Finding[];
  annotations: Annotation[];
  onClose: () => void;
  /** Open the replay dialog on this LLM span. */
  onReplay?: (spanId: string) => void;
}) {
  const { data: d, error } = useSpanDetail(traceId, spanId);
  const [tab, setTab] = useState<"io" | "attrs" | "raw">("io");
  const { annotate } = useRunActions(traceId);
  const mark = (label: "issue" | "good" | "note") => {
    const text = label === "note" ? window.prompt("Note for this span") : null;
    if (label === "note" && !text) return;
    annotate.mutate({ span_id: spanId!, label, text }, { onSuccess: () => toast.success(label === "note" ? "Note added to the span" : `Span marked as ${label}`) });
  };
  const v = d?.view;
  const kind = d ? spanKindBadge(d.kind) : null;
  // An end of 0 means the span hasn't ended (OTLP); an end before the start counts as 0 ms.
  const ended = !!d && !!d.end_ns && d.end_ns !== "0";
  const durationMs = d && ended ? Math.max(0, Number(BigInt(d.end_ns) - BigInt(d.start_ns || "0")) / 1e6) : 0;
  return (
    <Sheet open={!!spanId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="gap-2 border-b border-border px-6 py-4 pr-12">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-base font-normal">
            {kind && (
              <NeatBadge size="sm" variant={kind.variant}>
                {kind.label}
              </NeatBadge>
            )}
            <span className="truncate">{v?.toolName ?? d?.name ?? "Span"}</span>
            {d?.status.code === 2 && (
              <StatusPill size="sm" tone="danger">
                Failed
              </StatusPill>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
            {d && (
              <>
                <span>
                  {[ended ? dur(durationMs) : "not ended", v?.model, v?.totalTokens !== undefined ? `${num(v.promptTokens)} in / ${num(v.completionTokens)} out tokens` : null].filter(Boolean).join(" · ")}
                </span>
                <span className="inline-flex items-center gap-1 font-mono">
                  {midId(d.span_id)}
                  <CopyButton content={d.span_id} copyMessage="Span ID copied" />
                </span>
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
          {error && <p className="text-sm text-muted-foreground">Couldn't load this span: {(error as Error).message}</p>}
          {!d && !error && <p className="text-sm text-muted-foreground">Loading span…</p>}
          {findings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-warning-border bg-warning-surface px-3 py-2">
              <span className="text-xs text-warning-fg">Evidence for</span>
              {findings.map((f) => (
                <span key={f.id} className="text-sm text-foreground">
                  {f.title}
                </span>
              ))}
            </div>
          )}
          {v?.error && <pre className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap text-danger-fg">{v.error}</pre>}
          {d && (
            <>
              <SegmentedTabs
                size="compact"
                value={tab}
                onValueChange={setTab}
                items={[
                  { value: "io", label: "Input & output" },
                  { value: "attrs", label: "Attributes" },
                  { value: "raw", label: "Raw" },
                ]}
              />
              {tab === "io" && (
                <div className="flex flex-col gap-4">
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-xs text-muted-foreground">Input</span>
                    <MessageList value={v?.input} />
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-xs text-muted-foreground">Output</span>
                    <MessageList value={v?.output} />
                    {v?.tools && v.tools.length > 0 && <span className="text-xs text-muted-foreground">Tools offered: {v.tools.join(", ")}</span>}
                  </div>
                </div>
              )}
              {tab === "attrs" && (
                <div className="flex flex-col gap-4">
                  <KeyValues entries={Object.entries(d.attributes)} />
                  <span className="text-xs text-muted-foreground">Resource · {d.scope.name}</span>
                  <KeyValues entries={Object.entries(d.resource)} />
                </div>
              )}
              {tab === "raw" && <pre className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(d, null, 2)}</pre>}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-6 py-3">
          {annotations.map((a) => (
            <StatusPill key={a.id} size="sm" tone={a.label === "issue" ? "danger" : a.label === "good" ? "success" : "muted"}>
              {a.label === "issue" ? "Issue" : a.label === "good" ? "Good" : "Note"}
              {a.text ? `: ${a.text}` : ""}
            </StatusPill>
          ))}
          <span className="mr-auto text-xs text-muted-foreground">Your labels teach neatroots which findings matter.</span>
          {d?.kind === "LLM" && onReplay && (
            <Button size="sm" variant="secondary" onClick={() => (onClose(), onReplay(d.span_id))}>
              Replay this call
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => mark("issue")}>
            Mark as issue
          </Button>
          <Button size="sm" variant="ghost" onClick={() => mark("good")}>
            Mark as good
          </Button>
          <Button size="sm" variant="ghost" onClick={() => mark("note")}>
            Add note
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
