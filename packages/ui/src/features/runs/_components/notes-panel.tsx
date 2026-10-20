import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import type { Note } from "@/lib/api";
import { ago } from "@/lib/format";
import { NOTE_STATE } from "../_libs/labels";

/** Notes neatroots sent, or tried to send, to the running agent. Shown only when there are some. */
export function SteeringNotes({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  const delivered = notes.filter((n) => n.status === "delivered").length;
  return (
    <Panel>
      <PanelHeader title="Notes to the agent" actions={<span className="text-xs text-muted-foreground tabular-nums">{delivered} of {notes.length} delivered</span>} />
      <PanelContent>
        <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto">
          {notes.map((n) => {
            const state = NOTE_STATE[n.status];
            return (
              <li key={n.id} className="flex flex-col gap-1.5">
                <blockquote className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{n.text}</blockquote>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <StatusPill size="sm" tone={state.tone}>
                    {state.label}
                  </StatusPill>
                  {n.kind === "llm" ? (
                    <span className="inline-flex items-center gap-1">
                      <Icon icon={AiBrain01Icon} size="xxs" className="text-brand-violet" />
                      written by the LLM
                    </span>
                  ) : (
                    <span>{n.kind === "halt" ? "stop from your rule" : "from the check's template"}</span>
                  )}
                  <span>{n.delivered_ms ? `reached the agent ${ago(n.delivered_ms)}` : ago(n.created_ms)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </PanelContent>
    </Panel>
  );
}
