import type Database from "better-sqlite3";
import type { OtlpResource, OtlpSpan } from "../otlp/types.js";
import { buildView, type SpanView } from "../semantics/view.js";
import type { SpanRow } from "../types.js";
import type { IngestedSpan, TraceUpdate } from "./db.js";
import { genAiLogEvents } from "./genai-logs.js";
import { RefreshQueue, type SpanRef } from "./refresh-queue.js";

/** What late-log handling needs from the store it belongs to. */
export interface LateLogHost {
  /** The store's database (read when used: the store opens it after building this). */
  db: () => Database.Database;
  getSpans(traceId: string, includeMarker?: boolean): SpanRow[];
  getOtlpSpan(traceId: string, spanId: string): { span: OtlpSpan; resource: OtlpResource } | undefined;
  viewOf(full: { span: OtlpSpan; resource: OtlpResource }): SpanView;
  /** Writes a re-derived view's previews and search text. */
  applyView(traceId: string, spanId: string, name: string, view: SpanView): void;
}

/** What late logs can change in a span's view; equal signatures mean nothing new to show or ask about. */
function viewSignature(v: SpanView): string {
  return JSON.stringify([v.input, v.output, v.finishReason, v.toolCalls]);
}

/**
 * GenAI message content logged after its span (SDKs batch spans and logs separately). Spans it touched are
 * re-derived a bounded slice at a time; those whose view actually changed get a new revision and are announced
 * per run, so caches and the engine can react.
 */
export class LateLogs {
  private revs = new Map<string, number>();
  private listener?: (updates: TraceUpdate[]) => void;
  private readonly queue: RefreshQueue;

  constructor(private readonly host: LateLogHost) {
    this.queue = new RefreshQueue(
      (t) => this.refresh(t.traceId, t.spanId, t.since),
      (work) => host.db().transaction(work)(),
      undefined,
      (spans) => this.announce(spans),
    );
  }

  /** Queues spans whose logs just arrived; `since` on each is the first log row of the batch. */
  touched(spans: Iterable<SpanRef>): void {
    this.queue.queue(spans);
  }

  /** Called, per run, with the spans whose views changed because message content was logged after them. */
  onLateLogs(fn: ((updates: TraceUpdate[]) => void) | undefined): void {
    this.listener = fn;
  }

  /** Applies every pending refresh now. */
  flush(): void {
    this.queue.flush();
  }

  /** Changes whenever message content logged against a span re-derives its view, so caches of the view can tell. */
  revision(traceId: string, spanId: string): number {
    return this.revs.get(`${traceId}/${spanId}`) ?? 0;
  }

  /** Forgets the revisions of deleted runs. */
  forgetRuns(traceIds: Set<string>): void {
    for (const k of this.revs.keys()) if (traceIds.has(k.slice(0, k.indexOf("/")))) this.revs.delete(k);
  }

  /** How many spans carry a revision. */
  get revisions(): number {
    return this.revs.size;
  }

  /**
   * Re-derives a stored span after message content arrived for it. When the view built from the logs before
   * `since` matches the one built from all of them (say attributes already carried the content), the new logs
   * changed nothing: it returns false, so the span is not announced and its questions are not asked again.
   */
  private refresh(traceId: string, spanId: string, since?: number): boolean {
    const full = this.host.getOtlpSpan(traceId, spanId);
    if (!full) return false;
    const view = this.host.viewOf(full);
    if (view.isMarker) return false;
    if (since !== undefined) {
      const before = buildView(full.span, full.resource.attributes, () => genAiLogEvents(this.host.db(), traceId, spanId, since));
      if (viewSignature(before) === viewSignature(view)) return false;
    }
    this.revs.set(`${traceId}/${spanId}`, this.revision(traceId, spanId) + 1);
    this.host.applyView(traceId, spanId, full.span.name, view);
    return true;
  }

  private announce(spans: SpanRef[]): void {
    if (!this.listener) return;
    const byTrace = new Map<string, Set<string>>();
    for (const s of spans) byTrace.set(s.traceId, (byTrace.get(s.traceId) ?? new Set()).add(s.spanId));
    const updates: TraceUpdate[] = [];
    for (const [traceId, ids] of byTrace) {
      const refreshed: IngestedSpan[] = [];
      for (const row of this.host.getSpans(traceId, false).filter((r) => ids.has(r.span_id))) {
        const full = this.host.getOtlpSpan(traceId, row.span_id);
        if (full) refreshed.push({ row, view: this.host.viewOf(full), isNew: false });
      }
      if (refreshed.length) updates.push({ traceId, spans: refreshed, runCreated: false, rootEnded: false, rootHandedBack: false, completed: false, lateLogs: true });
    }
    if (updates.length) this.listener(updates);
  }
}
