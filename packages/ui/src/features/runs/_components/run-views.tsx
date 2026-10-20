import { Panel } from "@/components/ui/panel";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { Span } from "@/lib/api";
import { TraceTree } from "./trace-tree";
import { ChatView, type ForkHandlers } from "./views/chat-view";
import { ConversationView } from "./views/conversation-view";
import { TimelineView } from "./views/timeline";

export type RunView = "overview" | "trace" | "timeline" | "conversation";
export const RUN_VIEWS: RunView[] = ["overview", "trace", "timeline", "conversation"];

/**
 * One run, four ways: as a conversation, as the span tree, on a time axis, and as one turn of
 * its session. A box of fixed height; each view scrolls inside it.
 */
export function RunViews({
  traceId,
  spans,
  flagged,
  view,
  onView,
  selected,
  onSelect,
  hasSession,
  fork,
}: {
  traceId: string;
  spans: Span[];
  flagged: Set<string>;
  view: RunView;
  onView: (v: RunView) => void;
  selected?: string;
  onSelect: (id: string) => void;
  hasSession: boolean;
  fork?: ForkHandlers;
}) {
  return (
    <Panel className="gap-0 overflow-hidden p-0" data-testid="run-views">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6">
        <SegmentedTabs
          size="compact"
          value={view}
          onValueChange={onView}
          items={[
            { value: "overview", label: "Overview" },
            { value: "trace", label: "Trace" },
            { value: "timeline", label: "Timeline" },
            { value: "conversation", label: "Conversation", disabled: !hasSession },
          ]}
        />
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{view === "overview" ? "Edit a user message to fork the run" : "Select a span to open it"}</span>
      </div>
      <div className="h-[34rem] min-h-0">
        {view === "overview" ? (
          <ChatView traceId={traceId} onOpenSpan={onSelect} fork={fork} />
        ) : view === "trace" ? (
          <TraceTree spans={spans} flagged={flagged} selected={selected} onSelect={onSelect} />
        ) : view === "timeline" ? (
          <TimelineView spans={spans} flagged={flagged} selected={selected} onSelect={onSelect} />
        ) : (
          <ConversationView traceId={traceId} />
        )}
      </div>
    </Panel>
  );
}
