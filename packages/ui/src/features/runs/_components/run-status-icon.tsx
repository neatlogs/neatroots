import { Alert02Icon, AlertCircleIcon, CheckmarkCircle02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import type { RunStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RUN_STATE } from "../_libs/labels";

const ICON = { ok: CheckmarkCircle02Icon, error: AlertCircleIcon, interrupted: Alert02Icon, running: Loading03Icon } as const;
const TONE = { ok: "text-success-fg", error: "text-danger-fg", interrupted: "text-warning-fg", running: "text-info-fg animate-spin" } as const;

/** A run's outcome as a single icon, the way the Neatlogs traces table shows status. */
export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span role="img" aria-label={RUN_STATE[status].label} title={RUN_STATE[status].label} className={cn("inline-flex", className)}>
      <Icon icon={ICON[status]} size="sm" className={TONE[status]} />
    </span>
  );
}
