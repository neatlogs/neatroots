import type { AppliesTo } from "./types.js";

/**
 * Whether a check watches a run at all. A check with no `applies_to` watches every run; one with a
 * selector watches only the projects and workflows it names, and a selector with both set needs
 * both to match.
 *
 * One copy, used by the engine (which runs the check), by the home page's insights (which report
 * how many runs it ran on), and by `neatroots check` (which replays saved files). They drifted
 * once: insights counted every enabled rule against every run in the window, so a rule scoped to
 * another project showed up as having run and found nothing.
 */
export function checkAppliesTo(c: { applies_to?: AppliesTo }, run: { project: string; workflow: string }): boolean {
  const a = c.applies_to;
  if (!a) return true;
  const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  const projects = list(a.project);
  const workflows = list(a.workflow);
  if (projects && !projects.includes(run.project)) return false;
  if (workflows && !workflows.includes(run.workflow)) return false;
  return true;
}
