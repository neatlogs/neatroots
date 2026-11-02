import { ArrowDown01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import { CodeLine } from "@/components/code-line";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import type { AgentClient, ProjectRow, Status } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PendingButton } from "@/components/pending-button";
import { useLayaAction } from "../../settings/_services/settings-queries";

interface Step {
  id: string;
  title: string;
  /** The label in the one-line summary. */
  short: string;
  done: boolean;
  optional?: boolean;
  /** What is true now, shown when the step is done. */
  state: string;
  body: ReactNode;
}

function steps(status: Status, projects: ProjectRow[], agents: AgentClient[]): Step[] {
  const port = status.port;
  const llm = status.engine?.llm;
  const hosted = llm?.where && llm.where !== "local";
  const steered = projects.filter((p) => p.settings.steering !== "off");
  const names = projects.map((p) => p.project);
  const connected = agents.filter((a) => a.connected).map((a) => a.label);
  const found = agents.filter((a) => a.detected && !a.connected).map((a) => a.label);
  const steerPy = status.install?.steer_python ?? "~/.neatroots/app/steer/python/neatroots-steer";
  const laya = status.classifier?.laya;
  const layaReady = laya?.state === "running" || laya?.state === "external" || laya?.state === "stopped";
  const jevReady = !!status.classifier?.jev_cloud.enabled && !!status.classifier.jev_cloud.has_key;
  return [
    {
      id: "runs",
      short: "Runs arriving",
      title: "Send your agent's runs to neatroots",
      done: status.stats.runs > 0,
      state: `${status.stats.runs.toLocaleString()} runs from ${names.length} project${names.length === 1 ? "" : "s"}${names.length ? ` (${names.slice(0, 3).join(", ")})` : ""}`,
      body: (
        <>
          <p>neatroots reads what the Neatlogs SDK already sends. Set two variables where your agent runs; no code change is needed.</p>
          <CodeLine text={`export NEATLOGS_ENDPOINT=http://localhost:${port}\nexport NEATLOGS_API_KEY=neatroots-local`} />
          <p>Not using the SDK yet? Add it and name your agent; that name becomes the project here.</p>
          <CodeLine text={`neatlogs.init(workflow_name="my-agent", flush_interval=0.5)`} />
        </>
      ),
    },
    {
      id: "llm",
      short: "LLM",
      title: "Give neatroots an LLM to ask questions with",
      done: !!llm?.ok,
      state: llm?.ok ? `${llm.model}${hosted ? ` (hosted: ${llm.where})` : " on this machine"}` : "",
      body: (
        <>
          <p>Rules run without one. An LLM lets it pick the questions that fit your agent, explain problems and summarize runs. Run one locally:</p>
          <CodeLine text="ollama pull qwen3:8b" />
          <p>
            Or use a hosted model (opt-in; run content is sent to it): <span className="font-mono">neatroots llm use anthropic</span>, or{" "}
            <a className="text-foreground underline-offset-4 hover:underline" href="#/settings/models">
              Settings → Models
            </a>
            .
          </p>
        </>
      ),
    },
    {
      id: "decisions",
      short: "Check answers",
      title: "Choose how checks get answered: Laya on this machine, or Jev cloud",
      done: layaReady || jevReady,
      state: layaReady ? "Laya, on this machine" : jevReady ? "Jev cloud" : "",
      body: <DecisionChoice status={status} />,
    },
    {
      id: "mcp",
      short: "Coding agent",
      title: "Let your coding agent read what neatroots finds",
      optional: true,
      done: connected.length > 0 || !!status.mcp?.last_seen_ms,
      state: status.mcp?.last_seen_ms
        ? `${connected.length ? `${connected.join(", ")} connected; ` : ""}a coding agent last asked ${ago(status.mcp.last_seen_ms)}`
        : connected.length
          ? `${connected.join(", ")} connected`
          : "",
      body: (
        <>
          <p>
            Claude Code, Codex, Cursor and other coding agents can read your runs and findings, fix the problem and add a check so it is caught next time.
            {found.length ? ` Found here: ${found.join(", ")}.` : ""}
          </p>
          <CodeLine text="neatroots connect --detected" />
          <p>
            Or connect them one at a time in{" "}
            <a className="text-foreground underline-offset-4 hover:underline" href="#/settings/agents">
              Settings → Coding agents
            </a>
            . Then ask your agent: “Fix what neatroots found in my last run.”
          </p>
        </>
      ),
    },
    {
      id: "steering",
      short: "Steering",
      title: "Let neatroots nudge the agent while it runs",
      optional: true,
      done: steered.length > 0,
      state: steered.length ? `on for ${steered.map((p) => `${p.project} (${p.settings.steering})`).join(", ")}` : "",
      body: (
        <>
          <p>When a check fires mid-run, neatroots can add a short note to the agent's next LLM call. It needs a small hook in your agent.</p>
          <CodeLine text={`pip install ${steerPy}\nneatroots steering advisory --project ${names[0] ?? "my-agent"}`} />
          <p>
            Then wrap your client: <span className="font-mono">client = neatroots_steer.wrap(OpenAI())</span>. Turn it on per project in{" "}
            <a className="text-foreground underline-offset-4 hover:underline" href="#/settings/projects">
              Settings → Projects
            </a>
            .
          </p>
        </>
      ),
    },
    {
      id: "cloud",
      short: "Neatlogs Cloud",
      title: "Keep or share runs in Neatlogs Cloud",
      optional: true,
      done: status.cloud.has_key,
      state: status.cloud.has_key ? "API key stored" : "",
      body: (
        <>
          <p>Send a run you want to keep or show your team. neatroots removes secrets and personal data first, and sends nothing unless you ask.</p>
          <CodeLine text="neatroots cloud login" />
        </>
      ),
    },
  ];
}

/** Why neatroots wants Laya, the download, and the alternative. */
function DecisionChoice({ status }: { status: Status }) {
  const act = useLayaAction();
  const laya = status.classifier?.laya;
  const busy = laya?.state === "installing" || laya?.state === "starting";
  return (
    <>
      <p>
        neatroots checks each run with yes/no questions, such as "did the agent carry on after a tool failed?" Laya, an open 421M-parameter model, answers them on this machine:
        free, private and quick once it has learned your agent. It's a one-time download of about 1.4 GB.
      </p>
      <p>Rather not download it? Set up Jev cloud instead (the span content a question needs is sent to TypeSafe). Until one of them is set up, your LLM answers, more slowly.</p>
      {busy ? (
        <p className="text-xs">{laya?.message ?? "Downloading Laya…"}{laya?.progress != null ? ` · ${Math.round(laya.progress * 100)}%` : ""}</p>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <PendingButton size="sm" variant="secondary" pending={act.isPending} onClick={() => act.mutate("install")}>
            Download Laya
          </PendingButton>
          <a className={cn("text-foreground underline-offset-4 hover:underline")} href="#/settings/decisions">
            Set up Jev cloud
          </a>
          {laya?.consent === "no" && <span className="text-xs">You chose not to download Laya.</span>}
        </span>
      )}
    </>
  );
}

const DAILY = [
  "Run your agent as usual. neatroots checks every run as it happens.",
  "Start here: see what is failing more or less often, and which tools and checks are behind it.",
  "Open a problem to see the cause, the suggested fix and the span that shows it, or ask your coding agent to fix it.",
  "Dismiss findings that are wrong. neatroots counts them, so noisy checks show up.",
];

/**
 * How to use neatroots, as steps checked against what is actually set up. Expanded while the
 * essentials are missing; one line once they are done.
 */
export function SetupGuide({ status, projects, agents }: { status: Status; projects: ProjectRow[]; agents: AgentClient[] }) {
  const list = steps(status, projects, agents);
  const essentialsDone = list.filter((s) => !s.optional).every((s) => s.done);
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? !essentialsDone;
  const next = list.find((s) => !s.done && !s.optional) ?? list.find((s) => !s.done);
  const [active, setActive] = useState<string | undefined>(undefined);
  const current = active ?? next?.id;
  const doneCount = list.filter((s) => s.done).length;

  if (!expanded) {
    return (
      <div className="flex h-12 items-center justify-between gap-3 rounded-xl border border-border bg-surface-subtle px-4">
        <span className="flex min-w-0 items-center gap-x-4 overflow-hidden text-xs text-muted-foreground">
          {list.map((s) => (
            <span key={s.id} className="inline-flex shrink-0 items-center gap-1.5">
              <Icon icon={CheckmarkCircle02Icon} size="xs" className={s.done ? "text-success-fg" : "text-muted-foreground/40"} />
              {s.short}
            </span>
          ))}
        </span>
        <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setOpen(true)}>
          Show setup steps
        </Button>
      </div>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="How to use neatroots"
        actions={
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {doneCount} of {list.length} set up
            </span>
            {essentialsDone && (
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Hide steps
              </Button>
            )}
          </span>
        }
      />
      <PanelContent className="flex flex-col gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          neatroots checks your agent's runs on this machine: rules on every step, questions the LLM picks for your agent, and an explanation when something goes
          wrong. Nothing leaves this machine unless you turn it on.
        </p>
        <ol className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
          {list.map((s, i) => {
            const isOpen = current === s.id;
            return (
              <li key={s.id} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `setup-step-detail-${s.id}` : undefined}
                  aria-label={`${s.title}${s.done ? `, Done: ${s.state}` : next?.id === s.id ? ", Next" : ""}`}
                  title={s.title}
                  onClick={() => setActive(isOpen ? "" : s.id)}
                  className="flex h-14 w-full cursor-pointer items-center gap-3 px-4 py-1 text-left transition-colors hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-none"
                >
                  {s.done ? (
                    <Icon icon={CheckmarkCircle02Icon} size="sm" className="shrink-0 text-success-fg" />
                  ) : (
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong text-3xs text-muted-foreground tabular-nums">
                      {i + 1}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span data-testid="setup-step-title" title={s.title} className={cn("truncate text-sm leading-5", s.done ? "text-muted-foreground" : "text-foreground")}>
                      {s.title}
                      {s.optional && !s.done && <span className="ml-2 text-xs text-muted-foreground">optional</span>}
                    </span>
                    {(s.done || next?.id === s.id) && (
                      <span className="flex min-w-0 items-center gap-2 text-xs leading-4">
                        <span className={cn("font-medium", s.done ? "text-success-fg" : "text-foreground")}>{s.done ? "Done" : "Next"}</span>
                        {s.done && <span data-testid="setup-step-state" title={s.state} className="min-w-0 truncate text-muted-foreground">{s.state}</span>}
                      </span>
                    )}
                  </span>
                  <Icon icon={ArrowDown01Icon} size="xs" className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div id={`setup-step-detail-${s.id}`} data-testid="setup-step-detail" tabIndex={0} className="h-40 overflow-y-auto overscroll-contain border-t border-border/60 px-4 py-3 pl-11 text-sm text-muted-foreground">
                    <div className="flex min-w-0 flex-col gap-2">
                      <p className="break-words font-medium text-foreground">{s.title}</p>
                      {s.done && <p data-testid="setup-step-full-state" className="break-words">Done: {s.state}</p>}
                      {next?.id === s.id && <p className="font-medium text-foreground">Next step</p>}
                      {s.body}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-col gap-1.5">
          <span className="text-eyebrow text-muted-foreground">Day to day</span>
          <ol className="flex flex-col gap-1">
            {DAILY.map((d, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                <span className="w-4 shrink-0 text-xs tabular-nums">{i + 1}.</span>
                {d}
              </li>
            ))}
          </ol>
        </div>
      </PanelContent>
    </Panel>
  );
}
