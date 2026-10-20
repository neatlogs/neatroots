import { AiBrain01Icon, ArrowRight01Icon, Edit02Icon, Robot01Icon, Settings01Icon, UserIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Icon, type IconData } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";
import type { ChatItem } from "@/lib/api";
import { dur, num, pretty } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useRunChat } from "../../_services/view-queries";

const argText = (a: unknown) => {
  if (a == null) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object" && !Array.isArray(a)) return Object.entries(a as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
  return JSON.stringify(a);
};

function Row({ icon, iconClass, label, meta, onOpen, children }: { icon: IconData; iconClass?: string; label: string; meta?: ReactNode; onOpen?: () => void; children: ReactNode }) {
  return (
    <li className="group relative flex gap-3 pb-5 last:pb-1">
      <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-border group-last:hidden" />
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background", iconClass)}>
        <Icon icon={icon} size="sm" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
        <div className="flex min-h-6 items-center gap-2">
          <span className="text-eyebrow text-2xs text-muted-foreground">{label}</span>
          {meta}
          {onOpen && (
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onOpen}>
              View span
            </Button>
          )}
        </div>
        {children}
      </div>
    </li>
  );
}

/** Long text sits in a box of fixed height that scrolls, so turns stay aligned. */
function Body({ text, tone = "plain" }: { text: string; tone?: "plain" | "user" | "muted" }) {
  if (!text) return <span className="text-sm text-muted-foreground italic">empty</span>;
  return (
    <div
      className={cn(
        "max-h-60 overflow-y-auto text-sm break-words whitespace-pre-wrap",
        tone === "user" && "rounded-lg bg-muted px-3 py-2 text-foreground",
        tone === "muted" && "rounded-lg border border-border px-3 py-2 text-muted-foreground",
        tone === "plain" && "text-foreground",
      )}
    >
      {text}
    </div>
  );
}

function UserTurn({ item, onOpen, fork }: { item: Extract<ChatItem, { type: "user" }>; onOpen: () => void; fork?: ForkHandlers }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  return (
    <Row
      icon={UserIcon}
      label="user"
      onOpen={onOpen}
      meta={
        fork && !editing ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(true)}>
            <Icon icon={Edit02Icon} size="xs" />
            Edit and fork
          </Button>
        ) : null
      }
    >
      {editing && fork ? (
        <div className="flex flex-col gap-2">
          <Textarea aria-label="Edited message" rows={Math.min(8, Math.max(2, draft.split("\n").length))} value={draft} onChange={(e) => setDraft(e.target.value)} className="text-sm" />
          <div className="flex flex-wrap items-center gap-2">
            <PendingButton size="sm" variant="secondary" disabled={!draft.trim() || draft === item.text} pending={fork.pending === "llm"} onClick={() => fork.llm(item.span_id, item.text, draft)}>
              Re-run this LLM call
            </PendingButton>
            <PendingButton size="sm" variant="secondary" disabled={!draft.trim() || !fork.canRun} pending={fork.pending === "run"} onClick={() => fork.run(draft)} title={fork.canRun ? undefined : "Set up a replay command for this project first (Settings → Projects)"}>
              Re-run the agent
            </PendingButton>
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft(item.text))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Body text={item.text} tone="user" />
      )}
    </Row>
  );
}

function ToolTurn({ item, onOpen }: { item: Extract<ChatItem, { type: "tool" }>; onOpen: () => void }) {
  const [open, setOpen] = useState(item.status === "error");
  const failed = item.status === "error";
  return (
    <Row
      icon={Wrench01Icon}
      iconClass={failed ? "border-danger-border text-danger-fg" : "text-info-fg"}
      label="tool"
      onOpen={onOpen}
      meta={
        <>
          <span className="font-mono text-xs text-foreground">{item.name}</span>
          {failed && (
            <StatusPill size="sm" tone="danger">
              Failed
            </StatusPill>
          )}
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">{dur(item.duration_ms)}</span>
        </>
      }
    >
      <button type="button" className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide input and output" : "Show input and output"}
      </button>
      {open && (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-2xs text-muted-foreground">Input</span>
            <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{pretty(item.input) || "—"}</pre>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-2xs text-muted-foreground">Output</span>
            <pre className={cn("max-h-48 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs whitespace-pre-wrap", failed ? "border-danger-border bg-danger-surface text-danger-fg" : "border-border bg-muted")}>
              {item.error ?? (pretty(item.output) || "—")}
            </pre>
          </div>
        </div>
      )}
    </Row>
  );
}

export interface ForkHandlers {
  llm: (spanId: string, from: string, to: string) => void;
  run: (input: string) => void;
  canRun: boolean;
  pending: "llm" | "run" | null;
}

/**
 * The run as a conversation: what the user asked, what the model answered, the tools it called,
 * and sub-agents as cards you can open. Edit a user message to fork the run from there.
 */
export function ChatView({ traceId, onOpenSpan, fork }: { traceId: string; onOpenSpan: (id: string) => void; fork?: ForkHandlers }) {
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const agent = path.at(-1)?.id;
  const { data, isLoading, error } = useRunChat(traceId, agent);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {path.length > 0 && (
        <nav aria-label="Sub-agents" className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-6 text-xs">
          <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setPath([])}>
            Run
          </button>
          {path.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1.5">
              <Icon icon={ArrowRight01Icon} size="xs" className="text-muted-foreground/60" />
              <button type="button" className={cn("cursor-pointer", i === path.length - 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => setPath(path.slice(0, i + 1))}>
                {p.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">Couldn't read this run as a conversation: {(error as Error).message}</p>
        ) : !data?.items.length ? (
          <p className="text-sm text-muted-foreground">No messages recorded yet. LLM calls with their messages show up here; the Trace tab has every span.</p>
        ) : (
          <ol className="flex flex-col" data-testid="chat-view">
            {data.items.map((item, i) => {
              const open = () => onOpenSpan(item.span_id);
              const isHistory = (x: ChatItem | undefined) => !!x && (x.type === "user" || x.type === "assistant") && !!x.history;
              // Earlier turns, replayed in this turn's input: one label, then muted messages.
              if (isHistory(item)) {
                const h = item as Extract<ChatItem, { type: "user" | "assistant" }>;
                return (
                  <li key={i} className="flex flex-col gap-1 pb-3 pl-11">
                    {!isHistory(data.items[i - 1]) && <span className="text-eyebrow pb-1 text-2xs text-muted-foreground">Earlier in this conversation</span>}
                    <span className="flex gap-2 text-sm text-muted-foreground">
                      <span className="w-16 shrink-0 text-2xs uppercase">{h.type === "user" ? "user" : "assistant"}</span>
                      <span className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap">{h.text}</span>
                    </span>
                  </li>
                );
              }
              switch (item.type) {
                case "system":
                  return (
                    <Row key={i} icon={Settings01Icon} label="system prompt" onOpen={open}>
                      <details className="text-sm">
                        <summary className="cursor-pointer text-muted-foreground">{item.text.slice(0, 120)}{item.text.length > 120 ? "…" : ""}</summary>
                        <div className="mt-2">
                          <Body text={item.text} tone="muted" />
                        </div>
                      </details>
                    </Row>
                  );
                case "user":
                  return <UserTurn key={i} item={item} onOpen={open} fork={fork} />;
                case "assistant":
                  return (
                    <Row
                      key={i}
                      icon={AiBrain01Icon}
                      iconClass={item.error ? "border-danger-border text-danger-fg" : "text-brand-violet"}
                      label="assistant"
                      onOpen={open}
                      meta={
                        <span className="text-2xs text-muted-foreground tabular-nums">
                          {[item.model, item.tokens ? `${num(item.tokens)} tokens` : null].filter(Boolean).join(" · ")}
                        </span>
                      }
                    >
                      {item.text ? <Body text={item.text} /> : null}
                      {item.tool_calls.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.tool_calls.map((c, j) => (
                            <span key={j} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-subtle px-2 py-0.5 font-mono text-xs text-foreground" title={argText(c.arguments)}>
                              <Icon icon={Wrench01Icon} size="xs" className="shrink-0 text-info-fg" />
                              <span className="shrink-0">{c.name}</span>
                              <span className="truncate text-muted-foreground">({argText(c.arguments)})</span>
                            </span>
                          ))}
                          {item.inferred && <span className="text-2xs text-muted-foreground">read from the tool spans that ran next; the SDK didn't record this call</span>}
                        </div>
                      )}
                      {item.error && <pre className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap text-danger-fg">{item.error}</pre>}
                      {!item.text && !item.tool_calls.length && !item.error && <span className="text-sm text-muted-foreground italic">no reply recorded</span>}
                    </Row>
                  );
                case "tool":
                  return <ToolTurn key={i} item={item} onOpen={open} />;
                case "agent":
                  return (
                    <Row key={i} icon={Robot01Icon} label="sub-agent" onOpen={open}>
                      <div className={cn("flex flex-col gap-2 rounded-lg border px-4 py-3", item.status === "error" ? "border-danger-border" : "border-border")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-foreground">{item.name}</span>
                          {item.status === "error" && (
                            <StatusPill size="sm" tone="danger">
                              Failed
                            </StatusPill>
                          )}
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {item.llm_calls} LLM · {item.tool_calls} tool calls · {dur(item.duration_ms)}
                          </span>
                          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setPath([...path, { id: item.span_id, name: item.name }])}>
                            Open sub-agent
                          </Button>
                        </div>
                        {item.input && <p className="truncate text-xs text-muted-foreground">In: {item.input}</p>}
                        {item.output && <p className="truncate text-xs text-muted-foreground">Out: {item.output}</p>}
                      </div>
                    </Row>
                  );
              }
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
