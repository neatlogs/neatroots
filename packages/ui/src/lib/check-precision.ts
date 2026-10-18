import type { CheckPrecision } from "./api";
import { pct } from "./format";

export function checkMetric(p: CheckPrecision) {
  const actionable = p.basis === "actionable_v1";
  const known = actionable && p.assessment_known === true && p.precision !== null;
  return {
    known,
    count: actionable ? `${p.hits} counted findings` : `${p.hits} historical records`,
    assessment: known ? `${pct(p.precision!)} kept${p.noisy ? " · Noisy" : ""}` : "Kept rate unavailable · Noisy assessment unknown",
    detail: actionable
      ? "Each finding counts once after it is raised or made active. Failed and quiet findings count only if later raised or made active."
      : "Legacy totals may include failed or quiet records. Their lifetime basis cannot be reconstructed from retained findings; future activity cannot make this all-time ratio exact.",
  };
}
