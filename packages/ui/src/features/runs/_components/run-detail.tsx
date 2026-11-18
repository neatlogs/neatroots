import { BarChartHorizontalIcon, Download01Icon, GitForkIcon, MoreHorizontalIcon, PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DetailBreadcrumb, DetailLayout, DetailRailGroup, DetailTitle, PropertyRow } from "@/components/detail/detail-layout";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { post, type ForwardPreview, type RunDetail as Detail } from "@/lib/api";
import { ago, dur, midId, num } from "@/lib/format";
import { go } from "@/lib/router";
import { RUN_STATE, runGoal } from "../_libs/labels";
import { useRunActions, useRunDetail } from "../_services/run-queries";
import { useReplay, useReplayOptions } from "../_services/view-queries";
import { DeleteRunDialog } from "./delete-run-dialog";
import { ForwardDialog } from "./forward-dialog";
import { SteeringNotes } from "./notes-panel";
import { ProblemsPanel } from "./problems-panel";
import { ReplayDialog } from "./replay-dialog";
import { ReplaysPanel } from "./replays-panel";
import { RUN_VIEWS, RunViews, type RunView } from "./run-views";
import { SpanSheet } from "./span-sheet";

const SOURCE_LABEL: Record<string, string> = {
  "neatlogs-cloud": "Neatlogs Cloud",
  file: "a file",
};

/** The span to point at first: a failed span in the top problem's evidence, else its first evidence, else the first failure. */
function firstSpan(d: Detail): string | undefined {
  const open = d.findings.filter((f) => f.status === "raised" || f.status === "active").sort((a, b) => (b.triage_score ?? 0) - (a.triage_score ?? 0));
  const failed = new Set(d.spans.filter((s) => s.status_code === 2).map((s) => s.span_id));
  const evidence = open.find((f) => f.evidence_span_ids.length)?.evidence_span_ids ?? [];
  return evidence.find((id) => failed.has(id)) ?? evidence[0] ?? [...failed][0];
}

export function RunDetail({ traceId, query }: { traceId: string; query?: URLSearchParams }) {
  const { data: d, error, isLoading } = useRunDetail(traceId);
  const actions = useRunActions(traceId);
  const replay = useReplay(traceId);
  const [open, setOpen] = useState<string | undefined>(query?.get("span") ?? undefined);
  const [preview, setPreview] = useState<ForwardPreview>();
  const [investigating, setInvestigating] = useState<string>();
  const [replayFor, setReplayFor] = useState<{ span?: string } | null>(null);
  const [forking, setForking] = useState<"llm" | "run" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const rawView = query?.get("view");
  const view: RunView = rawView && (RUN_VIEWS as string[]).includes(rawView) ? (rawView as RunView) : "overview";
  const highlighted = open ?? (d ? firstSpan(d) : undefined);
  const names = useMemo(() => new Map((d?.spans ?? []).map((s) => [s.span_id, s.tool_name ?? s.name])), [d?.spans]);
  const { data: replayOpts } = useReplayOptions(traceId, !!d);

  useEffect(() => {
    const s = query?.get("span");
    if (s) setOpen(s);
  }, [query]);

  // Tell neatroots what is in focus, for the coding agent's get_current_run.
  useEffect(() => {
    void post("/api/focus", { trace_id: traceId, span_id: highlighted ?? null }).catch(() => undefined);
  }, [traceId, highlighted]);

  const breadcrumb = (label: string) => (
    <DetailBreadcrumb back={{ href: "#/runs" }} backLabel="Back to runs" leadingIcon={BarChartHorizontalIcon} items={[{ href: "#/runs", label: "Runs" }, { label }]} />
  );

  if (error || isLoading || !d) {
    return (
      <DetailLayout breadcrumb={breadcrumb(traceId.slice(0, 8))} rail={null}>
        <EmptyState
          variant="inline"
          state={error ? "error" : "loading"}
          title={error ? "Couldn't load this run" : "Loading run"}
          description={error ? `${(error as Error).message}. Retention may have removed it.` : undefined}
        />
      </DetailLayout>
    );
  }

  const r = d.run;
  const state = RUN_STATE[r.status];
  const openFindings = d.findings.filter((f) => f.status === "raised" || f.status === "active");
  const flagged = new Set(openFindings.flatMap((f) => f.evidence_span_ids));
  const goal = runGoal(r);
  const name = r.root_name ?? r.workflow ?? "Run";
  const needsExplanation = openFindings.length > 0 && !d.explanation;
  const setView = (v: RunView) => go(`runs/${traceId}${v === "overview" ? "" : `?view=${v}`}`);

  const fork = {
    canRun: !!replayOpts?.run,
    pending: forking,
    llm: (spanId: string, from: string, to: string) => {
      setForking("llm");
      replay.mutate(
        { span_id: spanId, edit: { from, to } },
        {
          onSuccess: (res) => (res.state === "succeeded" && res.new_trace_id ? (toast.success("Forked. Opening the new run."), go(`runs/${res.new_trace_id}`)) : toast.error(`Fork failed: ${res.error}`)),
          onError: (e) => toast.error(`Couldn't fork: ${(e as Error).message}`),
          onSettled: () => setForking(null),
        },
      );
    },
    run: (input: string) => {
      setForking("run");
      replay.mutate(
        { input },
        {
          onSuccess: () => toast.success("Re-running the agent with your edit. The new run appears under Replays."),
          onError: (e) => toast.error(`Couldn't re-run: ${(e as Error).message}`),
          onSettled: () => setForking(null),
        },
      );
    },
  };

  const headerActions = (
    <>
      <Button
        variant="muted"
        size="icon"
        aria-label={r.pinned ? "Unpin run" : "Pin run"}
        title={r.pinned ? "Unpin run" : "Pin run: keep it past retention"}
        onClick={() => actions.pin.mutate(!r.pinned, { onSuccess: () => toast.success(r.pinned ? "Run unpinned" : "Run pinned; retention keeps it") })}
      >
        <Icon icon={r.pinned ? PinOffIcon : PinIcon} size="xs" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="muted" size="icon" aria-label="More actions">
            <Icon icon={MoreHorizontalIcon} size="xs" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => actions.recheck.mutate(undefined, { onSuccess: () => toast.success("Re-running checks on this run") })}>Re-run checks</DropdownMenuItem>
          <DropdownMenuItem onClick={() => go(`agents?trace=${traceId}`)}>Ask a coding agent</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              actions.previewForward.mutate(undefined, {
                onSuccess: (p) => (p.has_key ? setPreview(p) : toast.error("Add your Neatlogs Cloud API key in Settings before sending runs.")),
              })
            }
          >
            Send to Neatlogs Cloud
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open(`/api/runs/${traceId}/snapshot`, "_blank")}>
            <Icon icon={Download01Icon} size="xs" />
            Download run JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-danger-fg" onClick={() => setDeleting(true)}>
            Delete run
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteRunDialog traceId={traceId} open={deleting} onOpenChange={setDeleting} />
      <Button variant="secondary" onClick={() => setReplayFor({})}>
        <Icon icon={GitForkIcon} size="xs" />
        Replay
      </Button>
      <PendingButton
        variant={needsExplanation ? "default" : "secondary"}
        pending={actions.explain.isPending}
        pendingLabel="Explaining…"
        onClick={() => actions.explain.mutate(undefined, { onError: (e) => toast.error(`Couldn't explain this run: ${(e as Error).message}`) })}
      >
        Explain run
      </PendingButton>
    </>
  );

  const rail = (
    <>
      <DetailRailGroup label="Run">
        <PropertyRow
          label="Status"
          value={
            <StatusPill size="sm" tone={state.tone} dot={r.status === "running" ? "ping" : false}>
              {state.label}
            </StatusPill>
          }
        />
        {r.workflow && <PropertyRow label="Workflow" value={<span className="truncate">{r.workflow}</span>} />}
        <PropertyRow label="Started" value={<span title={r.started_ms ? new Date(r.started_ms).toLocaleString() : undefined}>{ago(r.started_ms)}</span>} />
        <PropertyRow label="Duration" value={r.status === "running" ? "running" : dur(r.duration_ms)} />
        <PropertyRow label="LLM calls" value={num(r.llm_calls)} />
        <PropertyRow label="Tool calls" value={num(r.tool_calls)} />
        {r.total_tokens ? <PropertyRow label="Tokens" value={num(r.total_tokens)} /> : null}
        {d.import_source && <PropertyRow label="Imported from" value={SOURCE_LABEL[d.import_source] ?? d.import_source} />}
      </DetailRailGroup>
      <DetailRailGroup label="Checks">
        <PropertyRow label="Open problems" value={r.open_finding_count} tooltip="Findings of checks in the same group, such as one retry loop, count as one problem." />
        {d.coverage ? (
          <PropertyRow label="Questions" value={`${d.coverage.answered} of ${d.coverage.questions}`} tooltip="Questions answered for this run: the ones picked for this agent, the ones every tool-using agent gets, and your own. Rules run on every span as well." />
        ) : (
          d.plan && <PropertyRow label="Questions" value={d.plan.check_ids.length} tooltip="Questions picked for this agent. Rules run on every span as well." />
        )}
        <PropertyRow label="Steering" value={r.steering === "off" ? "off" : r.steering} tooltip="Whether neatroots could add notes to this run while it ran." />
        <PropertyRow label="Sent to Cloud" value={d.forwarded ? "yes" : "no"} />
        <PropertyRow label="Replays" value={d.replays.length} />
      </DetailRailGroup>
      <DetailRailGroup label="IDs">
        <PropertyRow
          label="Trace"
          value={
            <>
              <span className="truncate font-mono text-xs">{midId(r.trace_id)}</span>
              <CopyButton content={r.trace_id} copyMessage="Trace ID copied" />
            </>
          }
        />
        {r.session_id && (
          <PropertyRow
            label="Session"
            value={
              <>
                <span className="truncate font-mono text-xs">{r.session_id}</span>
                <CopyButton content={r.session_id} copyMessage="Session ID copied" />
              </>
            }
          />
        )}
      </DetailRailGroup>
    </>
  );

  return (
    <DetailLayout breadcrumb={breadcrumb(name)} headerActions={headerActions} rail={rail}>
      <div className="flex flex-col gap-6">
        <DetailTitle title={<span title={goal ?? undefined}>{goal ?? name}</span>} subtitle={d.summary?.text.split("\n").join(" ")} />
        {d.replay_of && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-subtle px-4 py-2.5 text-sm">
            <Icon icon={GitForkIcon} size="sm" className="text-muted-foreground" />
            <span className="text-muted-foreground">
              Replay of{" "}
              <a href={`#/runs/${d.replay_of.trace_id}`} className="text-foreground underline-offset-4 hover:underline">
                run {d.replay_of.trace_id.slice(0, 8)}
              </a>{" "}
              · {d.replay_of.kind === "llm" ? "one LLM call" : "the whole agent"}
              {d.replay_of.overrides.model ? ` on ${d.replay_of.overrides.model}` : ""}
            </span>
          </div>
        )}
        <ProblemsPanel
          findings={d.findings}
          plan={d.plan}
          coverage={d.coverage}
          onRecheck={() => actions.recheck.mutate(undefined, { onSuccess: () => toast.success("Re-running checks on this run") })}
          running={r.status === "running"}
          explanation={d.explanation}
          names={names}
          onPick={setOpen}
          investigating={investigating}
          onSetStatus={(id, status) =>
            actions.setFinding.mutate({ id, status }, { onSuccess: () => toast.success(status === "dismissed" ? "Finding dismissed" : "Finding reopened") })
          }
          onInvestigate={(id) => {
            setInvestigating(id);
            actions.investigate.mutate(id, {
              onError: (e) => toast.error(`Couldn't explain this finding: ${(e as Error).message}`),
              onSettled: () => setInvestigating(undefined),
            });
          }}
        />
        <RunViews traceId={traceId} spans={d.spans} flagged={flagged} view={view} onView={setView} selected={highlighted} onSelect={setOpen} hasSession={!!r.session_id} fork={fork} />
        <ReplaysPanel replays={d.replays} />
        <SteeringNotes notes={d.notes} />
      </div>
      <SpanSheet
        key={open}
        traceId={traceId}
        spanId={open}
        findings={open ? openFindings.filter((f) => f.evidence_span_ids.includes(open)) : []}
        annotations={open ? d.annotations.filter((a) => a.span_id === open) : []}
        onClose={() => setOpen(undefined)}
        onReplay={(spanId) => setReplayFor({ span: spanId })}
      />
      <ForwardDialog preview={preview} pending={actions.forward.isPending} onSend={() => actions.forward.mutateAsync()} onClose={() => setPreview(undefined)} />
      {replayFor && <ReplayDialog traceId={traceId} spans={d.spans} initialSpan={replayFor.span} onClose={() => setReplayFor(null)} />}
    </DetailLayout>
  );
}
