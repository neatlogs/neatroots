import { Panel, PanelHeader, PanelContent } from "@/components/ui/panel";
import type { RunDetail } from "@/lib/api";

const labels: Record<string, string> = {
  evaluating: "Evaluation started", waiting_end: "Waiting for run end", queued: "Queued", no_evidence: "No matching evidence",
  coalesced: "Coalesced targets", span_cap: "Span attempt cap reached", backend_unavailable: "Decision backend unavailable",
  evaluation_error: "Evaluation failed", missing_answer: "Decision answer missing", below_threshold: "Evaluated below threshold",
  flagged: "Flag raised", verification_rejected: "Flag rejected by verification", suppressed: "Suppressed after repeated rejections",
  quiet: "Quiet finding", rule_unknown: "Rule result unknown (no hit or skipped)", rule_clear: "Rule evaluated clear", resumed_answer: "Stored answer retained on resume",
};

export function CheckOutcomesPanel({ outcomes }: { outcomes: RunDetail["check_outcomes"] }) {
  return <Panel data-testid="check-outcomes-panel">
    <PanelHeader title="Check explanations" />
    <PanelContent>
      <div className="h-64 overflow-y-auto" aria-label="Check explanations">
        {!outcomes ? <p className="text-sm text-muted-foreground">Explanations unavailable for this run. Re-run checks to record observed outcomes.</p> : <>
          <p className="mb-3 text-xs text-muted-foreground">{outcomes.origin} generation {outcomes.generation.slice(0, 8)} · {new Date(outcomes.started_ms).toLocaleString()}. Counts are observations, including scheduling and repeated evaluations; they are not a pass rate. Up to 32 recent details per check.</p>
          {outcomes.previous_generation && <p className="mb-3 text-xs text-muted-foreground">Replaces generation {outcomes.previous_generation.slice(0, 8)}.</p>}
          {!outcomes.checks.length && <p className="text-sm text-muted-foreground">No check observations recorded yet.</p>}
          {outcomes.checks.map((check) => <details key={check.check_id} className="border-b border-border py-2 text-sm">
            <summary className="cursor-pointer break-words">{check.title} <span className="text-xs text-muted-foreground">({check.check_id})</span></summary>
            <ul className="space-y-1 py-2">{Object.entries(check.counts).map(([reason, count]) => <li key={reason} className={reason === "evaluation_error" || reason === "backend_unavailable" ? "text-destructive" : "text-muted-foreground"}>{labels[reason] ?? reason}: {count}</li>)}</ul>
            <ol className="space-y-1 text-xs text-muted-foreground">{check.recent.map((observation) => <li key={observation.sequence}>{new Date(observation.updated_ms).toLocaleTimeString()} · {labels[observation.reason] ?? observation.reason}{observation.target ? ` · span ${observation.target}` : ""}</li>)}</ol>
          </details>)}
          {outcomes.omitted_checks > 0 && <p className="text-sm text-muted-foreground">Additional check observations omitted at the storage limit: {outcomes.omitted_checks}.</p>}
        </>}
      </div>
    </PanelContent>
  </Panel>;
}
