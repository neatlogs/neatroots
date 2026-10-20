import { GitForkIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill } from "@/components/ui/status-pill";
import type { Replay } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

function what(r: Replay): string {
  if (r.kind === "llm") {
    const edited = r.overrides.messages?.filter((m) => m.role === "user").at(-1)?.content;
    return `One LLM call${r.overrides.model ? ` on ${r.overrides.model}` : ""}${edited ? `: “${edited.slice(0, 80)}”` : ""}`;
  }
  return `Whole run${r.overrides.model ? ` on ${r.overrides.model}` : ""}${r.overrides.input ? `: “${r.overrides.input.slice(0, 80)}”` : ""}`;
}

/** Runs forked from this one, newest first; each links to its own run. */
export function ReplaysPanel({ replays }: { replays: Replay[] }) {
  if (!replays.length) return null;
  return (
    <Panel data-testid="replays">
      <PanelHeader icon={<Icon icon={GitForkIcon} size="sm" />} title={`Replays · ${replays.length}`} />
      <PanelContent>
        <ul className="-mx-6 -mb-6 flex max-h-64 flex-col overflow-y-auto border-t border-border">
          {replays.map((r) => (
            <li key={r.id} className="h-20 shrink-0 border-b border-border/60 last:border-0">
              <a
                href={r.new_trace_id ? `#/runs/${r.new_trace_id}` : undefined}
                className={cn("flex h-14 items-center gap-3 px-6 py-2", r.new_trace_id && "transition-colors hover:bg-surface-subtle")}
              >
                {r.state === "running" ? (
                  <Spinner size="xs" />
                ) : (
                  <StatusPill size="sm" tone={r.state === "succeeded" ? "success" : "danger"}>
                    {r.state === "succeeded" ? "Done" : "Failed"}
                  </StatusPill>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{what(r)}</span>
                  <span className="truncate text-xs text-muted-foreground">{r.error ?? r.output_preview ?? (r.state === "running" ? "Waiting for the new run…" : "")}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(r.created_ms)}</span>
              </a>
              {r.new_trace_id && <a className="block px-6 pb-2 text-xs text-muted-foreground underline-offset-4 hover:underline" href={`#/compare?${new URLSearchParams({ a: r.trace_id, b: r.new_trace_id })}`}>Compare runs</a>}
            </li>
          ))}
        </ul>
      </PanelContent>
    </Panel>
  );
}
