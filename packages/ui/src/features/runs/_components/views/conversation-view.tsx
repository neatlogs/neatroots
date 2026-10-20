import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { dur, stamp } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";
import { RUN_STATE } from "../../_libs/labels";
import { useConversation } from "../../_services/view-queries";

/** Every run in this run's session, as numbered turns: what the user said, what came back. */
export function ConversationView({ traceId }: { traceId: string }) {
  const { data, isLoading } = useConversation(traceId, true);
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 px-6 py-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (!data?.session_id) {
    return (
      <p className="px-6 py-4 text-sm text-muted-foreground">
        This run isn't part of a session. Give runs a session id (<span className="font-mono">neatlogs.init(session_id=…)</span> or the <span className="font-mono">neatlogs.session.id</span> attribute) to see
        multi-turn conversations here.
      </p>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <p className="mb-3 text-xs text-muted-foreground">
        Session <span className="font-mono">{data.session_id}</span> · {data.runs.length} turn{data.runs.length === 1 ? "" : "s"}
      </p>
      <ol className="flex flex-col gap-3">
        {data.runs.map((r, i) => {
          const current = r.trace_id === traceId;
          const state = RUN_STATE[r.status];
          return (
            <li key={r.trace_id}>
              <button
                type="button"
                onClick={() => !current && go(`runs/${r.trace_id}?view=conversation`)}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-2 rounded-lg border px-4 py-3 text-left transition-colors",
                  current ? "border-foreground/30 bg-surface-subtle" : "border-border hover:bg-surface-subtle",
                )}
                aria-current={current ? "step" : undefined}
              >
                <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                  <span className="text-foreground">Turn {i + 1}</span>
                  <span className="font-mono">{stamp(r.started_ms).time}</span>
                  <span>{dur(r.duration_ms)}</span>
                  <StatusPill size="sm" tone={state.tone}>
                    {state.label}
                  </StatusPill>
                  {r.open_finding_count > 0 && (
                    <StatusPill size="sm" tone="warning">
                      {r.open_finding_count} problem{r.open_finding_count > 1 ? "s" : ""}
                    </StatusPill>
                  )}
                  {current && <span className="ml-auto">this run</span>}
                </span>
                {r.input_preview && <span className="line-clamp-3 rounded-md bg-muted px-3 py-2 text-sm text-foreground">{r.input_preview}</span>}
                {r.output_preview && <span className="line-clamp-3 text-sm text-muted-foreground">{r.output_preview}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
