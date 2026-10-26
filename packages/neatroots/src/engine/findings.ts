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

/**
 * A question got an answer, so it no longer "could not run" there: the span leaves the check's
 * failed row (one per run, listing the spans whose call failed), which goes once no span is left.
 * For a whole-run question the row just goes. Returns the rows changed or removed.
 */
export function clearFailure(store: Store, traceId: string, checkId: string, spanId: string | null): Finding[] {
  const changed: Finding[] = [];
  for (const f of store.failedFindingsFor(traceId, checkId)) {
    // A whole-run row (no span: the check was trace-scope when it failed) goes on any answer.
    const wholeRun = !f.detail.span_id;
    if (spanId && !wholeRun && !findingSpans(f).includes(spanId)) continue;
    const rest = spanId && !wholeRun ? dropOccurrence(store, f, spanId) : undefined;
    if (!rest) {
      store.deleteFinding(f.id);
      changed.push(f);
      continue;
    }
    // The row now leads with another span: show that span's own error.
    const errors = spanErrors(f);
    delete errors[spanId!];
    const lead = String(rest.detail.span_id ?? "");
    changed.push(store.updateFinding(rest.id, { detail: { ...rest.detail, errors, error: errors[lead] ?? rest.detail.error } }) ?? rest);
  }
  return changed;
}

/** Each failed span's own error on a failed row (older rows only have the first span's). */
export function spanErrors(f: Finding): Record<string, string> {
  const errors = f.detail.errors && typeof f.detail.errors === "object" ? { ...(f.detail.errors as Record<string, string>) } : {};
  const first = f.detail.span_id ? String(f.detail.span_id) : "";
  if (first && !(first in errors) && typeof f.detail.error === "string") errors[first] = f.detail.error;
  return errors;
}
