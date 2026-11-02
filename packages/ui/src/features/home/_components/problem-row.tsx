import { Alert02Icon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { Icon } from "@/components/ui/icon";
import type { Insights } from "@/lib/api";
import { useDismissHomeFinding } from "../_services/home-queries";

type Problem = Insights["problems"][number];
type Project = NonNullable<Problem["dismissal_projects"]>[number];

/** A separate, explicitly named project target for each check; never a cross-project action. */
export function ProblemRow({ problem, project, threshold }: { problem: Problem; project: Project; threshold?: number }) {
  const dismiss = useDismissHomeFinding();
  const busy = useRef(false);
  const [error, setError] = useState<string>();
  const id = project.newest_finding_id;
  const enabled = !!id && project.project !== null && !!threshold;
  const href = `#/runs?check=${encodeURIComponent(problem.check_id)}&label=${encodeURIComponent(problem.title)}${project.project !== null ? `&project=${encodeURIComponent(project.project)}` : ""}`;
  const act = async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      await dismiss.mutateAsync({ finding_id: id!, check_id: problem.check_id, project: project.project!, check_title: problem.title, project_name: project.name });
    } catch {
      setError("Could not dismiss this finding. Review the refreshed Home row and try again.");
    } finally {
      busy.current = false;
    }
  };
  const progress = project.project === null ? "no project, dismiss findings on its run page" : !threshold ? "dismissal progress unavailable" :
    project.dismissed >= threshold ? `${project.dismissed} of ${threshold} dismissals · new findings go quiet here` :
      `${project.dismissed} of ${threshold} dismissals until this check goes quiet here`;
  const detail = `${project.name} · in ${project.runs} run${project.runs === 1 ? "" : "s"} · ${progress}${!id && project.project !== null ? " · no open finding" : ""}`;
  // The same fixed height as Home's other rows. An error takes the detail line's place until the next try.
  return (
    <div data-testid="home-problem" className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 last:border-0">
      <Icon icon={Alert02Icon} size="xs" className="shrink-0 text-warning-fg" />
      <a href={href} title={`${problem.title} · ${detail}`} className="flex min-w-0 flex-1 flex-col rounded-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none">
        <span className="truncate text-sm text-foreground">{problem.title}</span>
        {error ? (
          <span role="alert" className="truncate text-xs text-danger-fg" title={error}>{error}</span>
        ) : (
          <span className="truncate text-xs text-muted-foreground tabular-nums">{detail}</span>
        )}
      </a>
      <PendingButton size="sm" variant="muted" className="shrink-0" pending={dismiss.isPending} pendingLabel="Dismissing…"
        disabled={!enabled} onClick={() => void act()}
        aria-label={`Dismiss finding for ${problem.title} in ${project.name}`}
        title={id ? `Dismiss this check's newest open finding in ${project.name}` : "No open finding in this project"}>
        Dismiss finding
      </PendingButton>
    </div>
  );
}
