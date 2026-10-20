import { AiBrain01Icon, BubbleChatIcon, Delete02Icon, UserIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ChatEvent, ChatSession } from "@/lib/api";
import { ago, pretty } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useChat, useChatActions, useChatAgents, useChatSessions } from "../_services/chat-queries";
import { OtherAgents } from "./other-agents";

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

function NewChat({ traceId, onCreated }: { traceId?: string; onCreated: (s: ChatSession) => void }) {
  const { data } = useChatAgents();
  const { create } = useChatActions();
  const installed = data?.agents.filter((a) => a.installed) ?? [];
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [cwd, setCwd] = useState("");
  const [edits, setEdits] = useState(false);
  const [commands, setCommands] = useState(false);
  useEffect(() => {
    if (installed.length && !installed.some((a) => a.id === agent)) setAgent(installed[0].id);
  }, [installed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data && !installed.length) {
    return (
      <EmptyState
        variant="bordered"
        icon={BubbleChatIcon}
        title="No coding agent found"
        description="Chats here run Claude Code or Codex. Install one (npm i -g @anthropic-ai/claude-code, or npm i -g @openai/codex; the Codex inside the ChatGPT app works too) and sign in once in a terminal. If it's installed somewhere neatroots doesn't look, set NEATROOTS_CLAUDE_BIN or NEATROOTS_CODEX_BIN."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-5">
      <div className="flex flex-col gap-1">
        <span className="text-body-medium text-foreground">Start a session</span>
        <span className="text-sm text-muted-foreground">
          {traceId ? (
            <>
              About run <span className="font-mono">{traceId.slice(0, 8)}</span>. The agent starts from it with neatroots' tools.
            </>
          ) : (
            "The agent runs in your project folder with neatroots' tools: it can read your runs, explain problems, replay, and add checks."
          )}
        </span>
      </div>
      <SegmentedTabs
        size="compact"
        value={agent}
        onValueChange={setAgent}
        items={(data?.agents ?? []).map((a) => ({ value: a.id, label: `${a.label}${a.installed ? "" : " (not installed)"}`, disabled: !a.installed }))}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Project folder, where your agent's code is (default: the project's replay folder, else your home folder)</span>
        <Input className="h-8 font-mono text-xs" placeholder="~/code/my-agent" value={cwd} onChange={(e) => setCwd(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={edits} onCheckedChange={setEdits} aria-label="Allow edits" />
          Allow file edits
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={commands} onCheckedChange={setCommands} aria-label="Allow commands" />
          Allow shell commands
        </label>
      </div>
      <div>
        <PendingButton pending={create.isPending} onClick={() => create.mutate({ agent, cwd: cwd || undefined, trace_id: traceId, allow_edits: edits, allow_commands: commands }, { onSuccess: onCreated })}>
          Start {AGENT_LABEL[agent]}
        </PendingButton>
      </div>
    </div>
  );
}

function EventRow({ e, results }: { e: ChatEvent; results: Map<string, ChatEvent> }) {
  if (e.kind === "user")
    return (
      <div className="flex gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border">
          <Icon icon={UserIcon} size="xs" />
        </span>
        <div className="max-h-60 min-w-0 flex-1 overflow-y-auto rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{e.text}</div>
      </div>
    );
  if (e.kind === "text")
    return (
      <div className="flex gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-brand-violet">
          <Icon icon={AiBrain01Icon} size="xs" />
        </span>
        <div className="min-w-0 flex-1 pt-1 text-sm break-words whitespace-pre-wrap text-foreground">{e.text}</div>
      </div>
    );
  if (e.kind === "tool" && e.tool) {
    const res = results.get(e.tool.id);
    return (
      <details className="group ml-10 rounded-lg border border-border">
        <summary className="flex h-9 cursor-pointer items-center gap-2 px-3 text-xs">
          <Icon icon={Wrench01Icon} size="xs" className={res?.tool?.is_error ? "text-danger-fg" : "text-info-fg"} />
          <span className="font-mono text-foreground">{e.tool.name.replace(/^mcp__neatroots(_app)?__/, "neatroots.")}</span>
          <span className="truncate text-muted-foreground">{typeof e.tool.input === "object" ? pretty(e.tool.input).replace(/\s+/g, " ").slice(0, 120) : ""}</span>
          {!res ? <Spinner size="xxs" /> : res.tool?.is_error ? <StatusPill size="sm" tone="danger">Failed</StatusPill> : null}
        </summary>
        <div className="grid gap-2 border-t border-border p-3 md:grid-cols-2">
          <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap">{pretty(e.tool.input)}</pre>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap">{res?.tool?.output ?? "…"}</pre>
        </div>
      </details>
    );
  }
  if (e.kind === "status") return <p className="ml-10 text-xs text-muted-foreground">{e.text}</p>;
  if (e.kind === "error") return <pre className="ml-10 rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-xs whitespace-pre-wrap text-danger-fg">{e.text}</pre>;
  if (e.kind === "result") {
    const m = e.meta ?? {};
    const denied = (m.denied as string[] | undefined) ?? [];
    return (
      <p className="ml-10 text-xs text-muted-foreground tabular-nums">
        {m.ok === false ? "Finished with an error" : "Done"}
        {typeof m.duration_ms === "number" ? ` · ${(m.duration_ms / 1000).toFixed(1)} s` : ""}
        {typeof m.cost_usd === "number" ? ` · $${m.cost_usd.toFixed(3)}` : ""}
        {denied.length ? ` · blocked: ${denied.join(", ")} (allow edits or commands to let it)` : ""}
        {e.text ? ` · ${e.text}` : ""}
      </p>
    );
  }
  return null;
}

function ChatPane({ id }: { id: string }) {
  const { session, events, running } = useChat(id);
  const { send, stop, update, remove } = useChatActions();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  // Block bodies only: an effect must return nothing or a cleanup function, and some browsers
  // return a value from scrollIntoView (React then calls it as a cleanup and the page goes blank).
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events.length]);
  // A chat opened from a run starts with the obvious question.
  useEffect(() => {
    if (session?.trace_id && !events.length && !text) setText("What went wrong in this run, and what should I change to fix it?");
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!session) return <Spinner />;
  const results = new Map(events.filter((e) => e.kind === "tool_result" && e.tool).map((e) => [e.tool!.id, e]));
  const submit = () => {
    if (!text.trim() || running) return;
    send.mutate({ id, text: text.trim() }, { onSuccess: () => setText("") });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-6 py-2">
        <span className="min-w-0 truncate text-sm text-foreground">{session.title}</span>
        <StatusPill size="sm" tone="neutral">
          {AGENT_LABEL[session.agent]}
        </StatusPill>
        <span className="hidden truncate font-mono text-2xs text-muted-foreground lg:inline">{session.cwd}</span>
        {session.trace_id && (
          <Button size="sm" variant="ghost" onClick={() => go(`runs/${session.trace_id}`)}>
            Open run
          </Button>
        )}
        <span className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <Switch checked={session.allow_edits} onCheckedChange={(v) => update.mutate({ id, allow_edits: v })} aria-label="Allow edits" />
            edits
          </label>
          <label className="flex items-center gap-1.5">
            <Switch checked={session.allow_commands} onCheckedChange={(v) => update.mutate({ id, allow_commands: v })} aria-label="Allow commands" />
            commands
          </label>
          <Button size="icon" variant="muted" aria-label="Delete chat" onClick={() => remove.mutate(id, { onSuccess: () => go("agents") })}>
            <Icon icon={Delete02Icon} size="xs" />
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!events.length ? (
          <p className="text-sm text-muted-foreground">Ask anything about your runs. For example: “Why did the last run fail, and what should I change?”</p>
        ) : (
          <div className="flex flex-col gap-3">
            {events
              .filter((e) => e.kind !== "tool_result")
              .map((e) => (
                <EventRow key={e.seq} e={e} results={results} />
              ))}
            {running && (
              <p className="ml-10 flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size="xxs" /> {AGENT_LABEL[session.agent]} is working…
              </p>
            )}
            <div ref={end} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-6 py-3">
        <Textarea
          aria-label="Message"
          rows={3}
          placeholder={running ? "Wait for the answer, or stop it" : `Message ${AGENT_LABEL[session.agent]}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="resize-none text-sm"
        />
        <div className="flex items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send · runs headless in {session.cwd}
          </span>
          {running && (
            <Button size="sm" variant="ghost" onClick={() => stop.mutate(id)}>
              Stop
            </Button>
          )}
          <PendingButton size="sm" pending={send.isPending} disabled={!text.trim() || running} onClick={submit}>
            Send message
          </PendingButton>
        </div>
      </div>
    </div>
  );
}

/** Claude Code and Codex inside neatroots: sessions on the left, the conversation on the right. */
export function AgentsPage({ sessionId, query }: { sessionId?: string; query: URLSearchParams }) {
  const { data } = useChatSessions();
  const traceId = query.get("trace") ?? undefined;
  const [creating, setCreating] = useState(!sessionId);
  useEffect(() => {
    setCreating(!sessionId);
  }, [sessionId]);
  const sessions = data?.sessions ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-60 shrink-0 flex-col border-b border-border md:max-h-none md:w-72 md:border-r md:border-b-0">
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Icon icon={BubbleChatIcon} />
          <span className="font-pixel text-base text-foreground">Coding agents</span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => (go("agents"), setCreating(true))}>
            New chat
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <li key={s.id}>
              <a href={`#/agents/${s.id}`} className={cn("flex h-14 flex-col justify-center gap-0.5 rounded-md px-3 transition-colors", s.id === sessionId ? "bg-muted" : "hover:bg-muted/50")}>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.title}</span>
                  {s.state === "running" && <Spinner size="xxs" />}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {AGENT_LABEL[s.agent]} · {ago(s.updated_ms)}
                </span>
              </a>
            </li>
          ))}
          {!sessions.length && <li className="px-3 py-2 text-xs text-muted-foreground">No chats yet.</li>}
        </ul>
      </aside>
      <section className="min-h-0 min-w-0 flex-1">
        {creating || !sessionId ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-8">
            <NewChat traceId={traceId} onCreated={(s) => go(`agents/${s.id}`)} />
            <OtherAgents />
          </div>
        ) : (
          <ChatPane key={sessionId} id={sessionId} />
        )}
      </section>
    </div>
  );
}
