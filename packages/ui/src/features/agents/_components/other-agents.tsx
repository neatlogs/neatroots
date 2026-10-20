import { CodeLine } from "@/components/code-line";
import { Button, buttonVariants } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { go } from "@/lib/router";
import { useChatAgents } from "../_services/chat-queries";

const PROMPT = "Look at my last run in neatroots, explain what went wrong, and add a check so it's caught next time.";

/**
 * The coding agents neatroots connects over MCP that can't run inside the app (Cursor, VS Code,
 * Claude Desktop, Gemini CLI …): open them where they live, with neatroots' tools already attached.
 */
export function OtherAgents() {
  const { data } = useChatAgents();
  const list = (data?.elsewhere ?? []).filter((a) => a.detected || a.connected);
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-5">
      <div className="flex flex-col gap-1">
        <span className="text-body-medium text-foreground">Your other coding agents</span>
        <span className="text-sm text-muted-foreground">
          These read neatroots over MCP in their own app or terminal; only Claude Code and Codex can run inside neatroots. Open one and ask it about your runs.
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-border/60 border-y border-border/60">
        {list.map((a) => (
          <li key={a.id} className="flex h-12 items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{a.label}</span>
            <StatusPill size="sm" tone={a.connected ? "success" : "muted"} className="hidden sm:inline-flex">
              {a.connected ? "Connected" : "Not connected"}
            </StatusPill>
            <span className="flex shrink-0 justify-end sm:w-44">
              {!a.connected ? (
                <Button size="sm" variant="ghost" onClick={() => go("settings/agents")}>
                  Connect {a.label}
                </Button>
              ) : a.open ? (
                <a href={a.open} className={buttonVariants({ size: "sm", variant: "secondary" })}>
                  Open {a.label}
                </a>
              ) : a.run ? (
                <span className="truncate font-mono text-xs text-muted-foreground" title={`Run ${a.run} in your project's folder`}>
                  $ {a.run}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">A prompt to start with</span>
        <CodeLine text={PROMPT} />
      </div>
    </div>
  );
}
