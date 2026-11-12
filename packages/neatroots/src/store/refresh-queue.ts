export interface SpanRef {
  traceId: string;
  spanId: string;
  /** The first log row of the batch that queued it: logs before this row are what the span showed already. */
  since?: number;
}

/** Spans re-derived per slice, so one big batch of late logs cannot hold the event loop for all of them at once. */
export const REFRESH_CHUNK = 100;

/**
 * Spans whose previews and search text must be re-derived after logs arrived for them. The first slice runs when
 * the spans are queued, so an ordinary batch is fully applied before ingestion returns; the rest of a larger batch
 * goes through on later turns of the event loop, a slice at a time. Every queued span is refreshed exactly once
 * per queueing: a span queued again while it waits is not repeated.
 */
export class RefreshQueue {
  private pending = new Map<string, SpanRef>();
  private timer: NodeJS.Immediate | undefined;

  constructor(
    /** Re-derives one span; returns false when its view came out unchanged, so nobody needs telling. */
    private readonly refresh: (span: SpanRef) => boolean | void,
    private readonly atomically: (work: () => void) => void,
    private readonly chunk = REFRESH_CHUNK,
    /** Told which spans a slice changed, once that slice has committed. */
    private readonly onRefreshed?: (spans: SpanRef[]) => void,
  ) {}

  /** How many spans are waiting to be refreshed. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Queues spans and refreshes the first slice now. A span already waiting keeps the earliest `since`, so the
   * comparison covers every batch that arrived before it was refreshed.
   */
  queue(spans: Iterable<SpanRef>): void {
    for (const s of spans) {
      const key = `${s.traceId}/${s.spanId}`;
      const prev = this.pending.get(key);
      // No `since` means "always refresh and tell", which wins over any bound.
      const since = !prev ? s.since : prev.since === undefined || s.since === undefined ? undefined : Math.min(prev.since, s.since);
      this.pending.set(key, { traceId: s.traceId, spanId: s.spanId, since });
    }
    this.drainSlice();
  }

  /** Refreshes everything still waiting, now. */
  flush(): void {
    this.stop();
    while (this.pending.size) this.runSlice();
  }

  /** Drops the scheduled slice (the spans stay queued until flushed). */
  stop(): void {
    if (this.timer) clearImmediate(this.timer);
    this.timer = undefined;
  }

  private drainSlice(): void {
    this.runSlice();
    this.scheduleSlice();
  }

  private scheduleSlice(): void {
    if (!this.pending.size || this.timer) return;
    this.timer = setImmediate(() => {
      this.timer = undefined;
      this.drainSlice();
    });
  }

  /** Never throws: a span that cannot be refreshed is reported once, and the rest still go on. */
  private runSlice(): void {
    const slice: [string, SpanRef][] = [];
    for (const entry of this.pending) {
      if (slice.length >= this.chunk) break;
      slice.push(entry);
    }
    // Leave the queue first, so a failed slice is not retried forever.
    for (const [key] of slice) this.pending.delete(key);
    const changed: SpanRef[] = [];
    try {
      this.atomically(() => {
        for (const [, s] of slice) if (this.refresh(s) !== false) changed.push(s);
      });
    } catch (e) {
      console.error("neatroots: refreshing spans after late logs failed:", e);
      return;
    }
    try {
      if (changed.length) this.onRefreshed?.(changed);
    } catch (e) {
      console.error("neatroots: reporting refreshed spans failed:", e);
    }
  }
}
