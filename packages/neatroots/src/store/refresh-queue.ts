export interface SpanRef {
  traceId: string;
  spanId: string;
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
    private readonly refresh: (span: SpanRef) => void,
    private readonly atomically: (work: () => void) => void,
    private readonly chunk = REFRESH_CHUNK,
    /** Told which spans a slice refreshed, once that slice has committed. */
    private readonly onRefreshed?: (spans: SpanRef[]) => void,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  queue(spans: Iterable<SpanRef>): void {
    for (const s of spans) this.pending.set(`${s.traceId}/${s.spanId}`, s);
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
    try {
      this.atomically(() => {
        for (const [, s] of slice) this.refresh(s);
      });
    } catch (e) {
      console.error("neatroots: refreshing spans after late logs failed:", e);
      return;
    }
    try {
      this.onRefreshed?.(slice.map(([, s]) => s));
    } catch (e) {
      console.error("neatroots: reporting refreshed spans failed:", e);
    }
  }
}
