import { useRef, useState } from "react";
import { PendingButton } from "@/components/pending-button";
import type { Insights } from "@/lib/api";
import { useDismissHomeFinding } from "../_services/home-queries";

type Problem = Insights["problems"][number];
type Project = NonNullable<Problem["dismissal_projects"]>[number];

/** A separate, explicitly named project target for each check; never a cross-project action. */
export function ProblemRow({ problem, project, threshold }: { problem: Problem; project: Project; threshold?: number }) {
  const dismiss = useDismissHomeFinding();
  const busy = useRef(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  const id = project.newest_finding_id;
  const enabled = !!id && project.project !== null && !!threshold;
  const href = `#/runs?check=${encodeURIComponent(problem.check_id)}&label=${encodeURIComponent(problem.title)}${project.project !== null ? `&project=${encodeURIComponent(project.project)}` : ""}`;
  const act = async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    setMessage(undefined);
    try {
      await dismiss.mutateAsync({ finding_id: id!, check_id: problem.check_id, project: project.project! });
      setMessage({ error: false, text: `Dismissed finding in ${project.name}.` });
    } catch (error) {
      setMessage({ error: true, text: (error as Error).message });
    } finally {
      busy.current = false;
    }
  };
  return (
    <div data-testid="home-problem" className="flex h-36 shrink-0 flex-col gap-1 border-b border-border/60 px-4 py-3 last:border-0">
      <div className="flex items-start gap-2">
        <a href={href} className="min-w-0 flex-1 rounded-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none">
          <p className="truncate text-sm text-foreground" title={problem.title}>{problem.title}</p>
          <p className="truncate text-xs text-muted-foreground" title={project.name}>{project.name} · in {project.runs} run{project.runs === 1 ? "" : "s"}</p>
        </a>
        <PendingButton size="sm" variant="muted" className="shrink-0" pending={dismiss.isPending} pendingLabel="Dismissing…"
          disabled={!enabled} onClick={() => void act()}
          aria-label={`Dismiss finding for ${problem.title} in ${project.name}`}
          title={id ? `Dismiss this check's newest open finding in ${project.name}` : "No open finding in this project"}>
          Dismiss finding
        </PendingButton>
      </div>
      <p className="min-h-8 text-xs text-muted-foreground tabular-nums">
        {project.project === null ? "This run has no project; dismiss findings on its run page." : threshold ?
          project.dismissed >= threshold ? `${project.dismissed} of ${threshold} dismissals · new findings go quiet here` :
            `${project.dismissed} of ${threshold} dismissals until this check goes quiet here` : "Dismissal progress unavailable."}
      </p>
      <p role={message?.error ? "alert" : "status"} className={`h-8 overflow-y-auto text-xs ${message?.error ? "text-danger-fg" : "text-muted-foreground"}`}>
        {message?.text}{!id && project.project !== null && <span>{message ? " · " : ""}No open finding</span>}
      </p>
    </div>
  );
}
