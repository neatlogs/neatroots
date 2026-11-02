import { AiBrain01Icon, Alert02Icon, ArrowDown01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Panel, PanelContent, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill } from "@/components/ui/status-pill";
import type { CheckCoverage, Explanation, Finding, Plan } from "@/lib/api";
import { pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FINDING_STATE } from "../_libs/labels";
import { EvidenceChips } from "./evidence-chips";
import { ExplanationBlock } from "./insight-panels";

const ORDER = { raised: 0, active: 1, resolved: 2, quiet: 3, dismissed: 4, failed: 5 } as const;
const isOpen = (f: Finding) => f.status === "raised" || f.status === "active";

/**
 * One row per problem: open findings of checks in the same group (a retry loop trips three
 * checks) share a row, headed by the most specific one (a rule, then the most important).
 */
function problems(live: Finding[]): Finding[][] {
  const rows: Finding[][] = [];
  const byGroup = new Map<string, Finding[]>();
  for (const f of live) {
    const g = typeof f.detail.group === "string" && isOpen(f) ? f.detail.group : undefined;
    if (!g) {
      rows.push([f]);
      continue;
    }
    const row = byGroup.get(g);
    if (row) row.push(f);
    else {
      const fresh = [f];
      byGroup.set(g, fresh);
      rows.push(fresh);
    }
  }
  const rank = (f: Finding) => (f.check_kind === "rule" ? 0 : 1);
  for (const row of rows) row.sort((a, b) => rank(a) - rank(b) || (b.triage_score ?? 0) - (a.triage_score ?? 0) || (b.probability ?? 0) - (a.probability ?? 0));
  return rows;
}

/** How likely, honestly: an LLM's own probability isn't calibrated, so it gets words, not a number. */
function likelihood(f: Finding): string | null {
  if (f.probability === null) return null;
  if (f.detail.backend !== "llm") return `${pct(f.probability)} likely`;
  return `${f.probability >= 0.85 ? "Very likely" : f.probability >= 0.7 ? "Likely" : "Possibly"} (LLM judgment)`;
}

/**
 * What broke in this run, most important first. Rows share one height; a row opens for the
 * cause, the fix and the spans that show it. The list scrolls inside the panel.
 */
export function ProblemsPanel({
  findings,
  plan,
  coverage,
  running,
  explanation,
  names,
  onPick,
  onSetStatus,
  onInvestigate,
  onRecheck,
  investigating,
}: {
  findings: Finding[];
  plan: Plan | null;
  coverage?: CheckCoverage | null;
  running: boolean;
  explanation: Explanation | null;
  names: Map<string, string>;
  onPick: (id: string) => void;
  onSetStatus: (id: string, status: string) => void;
  onInvestigate: (id: string) => void;
  onRecheck?: () => void;
  investigating?: string;
}) {
  const live = findings.filter((f) => f.status !== "failed").sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.triage_score ?? 0) - (a.triage_score ?? 0));
  const failed = findings.filter((f) => f.status === "failed");
  const rows = problems(live);
  const open = rows.filter((r) => isOpen(r[0]));
  const [expanded, setExpanded] = useState<string | undefined>(open[0]?.[0].id);
  return (
    <Panel data-testid="problems">
      <PanelHeader
        title={open.length ? `${open.length} problem${open.length > 1 ? "s" : ""}` : "Problems"}
        actions={coverage ? <CoverageLine c={coverage} /> : plan ? <span className="hidden text-xs text-muted-foreground sm:inline">{plan.check_ids.length} questions for this agent, plus rules on every span</span> : undefined}
      />
      <PanelContent className="flex flex-col gap-4">
        {explanation && (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-4">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon icon={AiBrain01Icon} size="xxs" className="text-brand-violet" />
              Likely cause · {explanation.model ?? "LLM"}
            </span>
            <ExplanationBlock exp={explanation} names={names} onPick={onPick} />
          </div>
        )}
        {live.length === 0 ? (
          <CleanResult c={coverage} running={running} onRecheck={onRecheck} />
        ) : (
          <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {rows.map(([f, ...related]) => (
              <ProblemRow
                key={f.id}
                f={f}
                related={related}
                names={names}
                expanded={expanded === f.id}
                onToggle={() => setExpanded(expanded === f.id ? undefined : f.id)}
                onPick={onPick}
                onSetStatus={onSetStatus}
                onInvestigate={onInvestigate}
                investigating={investigating === f.id}
              />
            ))}
          </ul>
        )}
        {failed.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {failed.length} check{failed.length > 1 ? "s" : ""} could not run. A model error never counts as a pass.
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {failed.map((f) => (
                <li key={f.id}>
                  {f.title}: <span className="font-mono">{String(f.detail.error ?? "")}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </PanelContent>
    </Panel>
  );
}

function ProblemRow({
  f,
  related,
  names,
  expanded,
  onToggle,
  onPick,
  onSetStatus,
  onInvestigate,
  investigating,
}: {
  f: Finding;
  related: Finding[];
  names: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onSetStatus: (id: string, status: string) => void;
  onInvestigate: (id: string) => void;
  investigating: boolean;
}) {
  const state = FINDING_STATE[f.status];
  const open = isOpen(f);
  const where = [...new Set(f.evidence_span_ids.map((id) => names.get(id)).filter(Boolean))];
  const preview =
    f.explanation?.cause ?? (related.length ? `Also: ${related.map((r) => r.title).join(" · ")}` : where.length ? `Seen in ${where.slice(0, 3).join(", ")}` : "");
  const calls = Array.isArray(f.detail.occurrences) ? f.detail.occurrences.length + 1 : 0;
  const quote = typeof f.detail.quote === "string" ? f.detail.quote : null;
  const facts = [
    f.check_kind === "rule" ? "Rule" : "Question",
    likelihood(f),
    calls > 1 ? `in ${calls} calls` : null,
    f.precision.precision !== null && f.precision.hits >= 3 ? `${pct(f.precision.precision)} of past findings kept` : null,
  ].filter(Boolean);
  const group = [f, ...related];
  const allParams = Object.entries((f.detail.params ?? {}) as Record<string, string>).filter(([, v]) => v);
  const tool = allParams.find(([key]) => key === "tool")?.[1];
  const error = allParams.find(([key]) => key === "error")?.[1];
  const params = allParams.filter(([key]) => key !== "tool" && key !== "error").slice(0, 2);
  return (
    <li>
      <button type="button" aria-expanded={expanded} aria-label={`${f.title}${preview ? `. ${preview}` : ""}. ${state.label}`} title={`${f.title}${preview ? ` — ${preview}` : ""}`} onClick={onToggle} className="flex h-14 w-full cursor-pointer items-center gap-3 px-4 py-1 text-left transition-colors hover:bg-surface-subtle focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-sm leading-5", open ? "font-medium text-foreground" : "text-muted-foreground")}>{f.title}</span>
          <span className="truncate text-xs leading-4 text-muted-foreground">{preview || " "}</span>
        </span>
        <StatusPill size="sm" tone={state.tone}>
          {state.label}
        </StatusPill>
        <Icon icon={ArrowDown01Icon} size="sm" className={cn("shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div data-testid="problem-detail" tabIndex={0} className="h-48 overflow-y-auto overscroll-contain border-t border-border bg-surface-subtle/40 px-4 py-3 sm:h-56">
          <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0 max-w-full space-y-1">
            <p data-testid="finding-full-title" className="break-words font-medium text-foreground">{f.title}</p>
            {preview && <p data-testid="finding-full-preview" className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{preview}</p>}
          </div>
          {f.status === "quiet" && (
            <p className="text-xs text-muted-foreground">Quiet: this check was dismissed 3 times in this project, so it no longer counts here. Reopen it to count it.</p>
          )}
          {f.explanation ? <ExplanationBlock exp={f.explanation} names={names} onPick={onPick} /> : <EvidenceChips ids={f.evidence_span_ids} names={names} onPick={onPick} />}
          {quote && (
            <p className="text-xs">
              <span className="text-muted-foreground">Shown by </span>
              <span className="text-foreground">“{quote}”</span>
            </p>
          )}
          {related.length > 0 && (
            <p className="text-xs">
              <span className="text-muted-foreground">Also matched </span>
              <span className="text-foreground">{related.map((r) => r.title).join(" · ")}</span>
            </p>
          )}
          {tool && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Tool</span>
              <span data-testid="finding-tool" title={tool} className="min-w-0 max-w-full break-words rounded-md border border-border bg-background px-2 py-0.5 font-mono text-foreground">{tool}</span>
            </div>
          )}
          {error && (
            <div data-testid="finding-error" role="note" className="flex min-w-0 flex-col gap-1 rounded-lg border border-danger-border bg-danger-surface px-3 py-2">
              <span className="text-xs font-medium text-danger-fg">{tool ? "Tool error" : "Error detail"}</span>
              <pre data-testid="finding-error-copy" title={error} className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-danger-fg">{error}</pre>
            </div>
          )}
          {params.map(([k, v]) => (
            <p key={k} className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-xs">
              <span className="text-muted-foreground">{k} </span>
              <span className="min-w-0 max-w-full whitespace-pre-wrap break-words text-foreground">{v}</span>
            </p>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {facts.join(" · ")} · <span className="font-mono">{f.check_id}</span>
            </span>
            <span className="flex items-center gap-1">
              {!f.explanation && open && (
                <Button size="sm" variant="ghost" disabled={investigating} onClick={() => onInvestigate(f.id)}>
                  {investigating && <Spinner size="xs" />}
                  {investigating ? "Explaining…" : "Explain finding"}
                </Button>
              )}
              {open ? (
                <Button size="sm" variant="muted" title="Not a problem. Counts against this check's precision." onClick={() => group.forEach((g) => onSetStatus(g.id, "dismissed"))}>
                  Dismiss finding
                </Button>
              ) : (
                (f.status === "dismissed" || f.status === "quiet") && (
                  <Button size="sm" variant="muted" onClick={() => onSetStatus(f.id, "raised")}>
                    Reopen finding
                  </Button>
                )
              )}
            </span>
          </div>
          </div>
        </div>
      )}
    </li>
  );
}

/** "4 of 5 questions answered": what actually ran, next to the result. */
function CoverageLine({ c }: { c: CheckCoverage }) {
  if (!c.questions) return <span className="hidden text-xs text-muted-foreground sm:inline">Rules on every span</span>;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:inline-flex">
      {c.state === "checking" && <Spinner size="xxs" />}
      {c.answered} of {c.questions} questions answered{c.failed ? ` · ${c.failed} failed` : ""} · rules on every span
    </span>
  );
}

/**
 * The result when nothing was found. Green only when the questions really ran; otherwise it says
 * what is still running, what failed, or that only rules checked the run.
 */
function CleanResult({ c, running, onRecheck }: { c?: CheckCoverage | null; running: boolean; onRecheck?: () => void }) {
  if (!c || c.state === "done" || !c.questions) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon icon={CheckmarkCircle02Icon} size="sm" className="text-success-fg" />
        {running ? "Nothing found yet. neatroots checks each span as it arrives." : c?.questions ? `Nothing found. Rules and all ${c.questions} questions passed.` : "Nothing found. Every check that ran on this run passed."}
      </p>
    );
  }
  if (c.state === "checking") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
        <Spinner size="xs" />
        Nothing found so far. Checking: {c.answered} of {c.questions} questions answered.
      </p>
    );
  }
  const text =
    c.state === "rules-only"
      ? `Only rules checked this run. Its ${c.questions} questions didn't run because no model is available.`
      : c.state === "interrupted"
        ? `Checking stopped when neatroots restarted: ${c.answered} of ${c.questions} questions were answered.`
        : `Rules found nothing, but only ${c.answered} of ${c.questions} questions were answered${c.failed ? ` (${c.failed} failed)` : ""}.`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm" role="status">
      <span className="flex items-start gap-2 text-foreground">
        <Icon icon={Alert02Icon} size="sm" className="mt-0.5 shrink-0 text-warning-fg" />
        {text}
      </span>
      <span className="flex flex-wrap items-center gap-2 pl-6">
        {!c.model.available && (
          <a href="#/settings/models" className="text-xs text-foreground underline-offset-4 hover:underline">
            Set up a model
          </a>
        )}
        {onRecheck && (
          <Button size="sm" variant="secondary" onClick={onRecheck}>
            Re-run checks
          </Button>
        )}
      </span>
    </div>
  );
}
