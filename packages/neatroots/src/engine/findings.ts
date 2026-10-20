import type { Store } from "../store/db.js";
import type { Finding, FindingStatus } from "../types.js";

// How findings are kept few and honest: a question about single spans raises one finding per run
// (later spans that show the same problem join it), and a check the person keeps dismissing in a
// project goes quiet there.

/** Statuses that keep a finding open for dedupe; quiet ones are open but don't count. */
export const OPEN_STATUSES: FindingStatus[] = ["raised", "active", "quiet"];

export const isOpenFinding = (f: Finding) => OPEN_STATUSES.includes(f.status);

/** Dismissals in one project after which a check goes quiet there. */
export const QUIET_AFTER = 3;

/** The spans a span-scope finding covers: the one that raised it, then later ones. */
export function findingSpans(f: Finding): string[] {
  const occ = Array.isArray(f.detail.occurrences) ? (f.detail.occurrences as string[]) : [];
  return [...new Set([String(f.detail.span_id ?? ""), ...occ].filter(Boolean))];
}

/** Another span shows the same problem: it joins the run's finding instead of raising a new one. */
export function addOccurrence(store: Store, f: Finding, spanId: string, spanIds: string[]): Finding | undefined {
  const others = findingSpans(f).filter((s) => s !== f.detail.span_id);
  if (spanId !== f.detail.span_id && !others.includes(spanId)) others.push(spanId);
  return store.updateFinding(f.id, {
    evidence_span_ids: [...new Set([...f.evidence_span_ids, ...spanIds])],
    detail: { ...f.detail, occurrences: others },
  });
}

/**
 * A span no longer shows the problem. Returns the finding without it, or undefined when it was
 * the finding's only span (the caller resolves it).
 */
export function dropOccurrence(store: Store, f: Finding, spanId: string): Finding | undefined {
  const rest = findingSpans(f).filter((s) => s !== spanId);
  if (!rest.length) return undefined;
  return store.updateFinding(f.id, {
    evidence_span_ids: f.evidence_span_ids.filter((id) => id !== spanId),
    detail: { ...f.detail, span_id: rest[0], occurrences: rest.slice(1) },
  });
}

/** The status a new finding gets: quiet once the check has been dismissed often in this project. */
export function newFindingStatus(store: Store, checkId: string, project: string): "raised" | "quiet" {
  return store.dismissalsIn(checkId, project) >= QUIET_AFTER ? "quiet" : "raised";
}
