import { describe, expect, it, vi } from "vitest";
import { RefreshQueue, type SpanRef } from "../src/store/refresh-queue.js";

const span = (n: number): SpanRef => ({ traceId: "t", spanId: String(n) });
const tick = () => new Promise((r) => setImmediate(r));

describe("RefreshQueue", () => {
  it("keeps going with the remaining spans when a scheduled slice fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const q = new RefreshQueue(
      (s) => {
        if (s.spanId === "3") throw new Error("boom");
        done.push(s.spanId);
      },
      (work) => work(),
      2,
    );
    q.queue([1, 2, 3, 4, 5, 6].map(span));
    expect(done).toEqual(["1", "2"]);
    for (let i = 0; i < 5; i++) await tick();
    // 3 failed and is not retried; 4 was in the failed slice, 5 and 6 still ran.
    expect(done).toEqual(["1", "2", "5", "6"]);
    expect(q.size).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("flush and queue never throw, and flush finishes the spans after a failure", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const q = new RefreshQueue(
      (s) => {
        if (s.spanId === "1") throw new Error("boom");
        done.push(s.spanId);
      },
      (work) => work(),
      1,
    );
    expect(() => q.queue([1, 2, 3].map(span))).not.toThrow();
    expect(() => q.flush()).not.toThrow();
    expect(done).toEqual(["2", "3"]);
    expect(q.size).toBe(0);
    error.mockRestore();
  });

  it("does not repeat a span queued again while it waits", () => {
    const done: string[] = [];
    const q = new RefreshQueue((s) => done.push(s.spanId), (work) => work(), 1);
    q.queue([span(1), span(2)]);
    q.queue([span(2)]);
    q.flush();
    expect(done).toEqual(["1", "2"]);
  });

  it("tells only about spans whose refresh changed something", () => {
    const told: string[][] = [];
    const q = new RefreshQueue((s) => s.spanId !== "2", (work) => work(), 10, (spans) => told.push(spans.map((s) => s.spanId)));
    q.queue([1, 2, 3].map(span));
    q.queue([span(2)]);
    expect(told).toEqual([["1", "3"]]);
  });

  it("keeps the earliest bound for a span queued again while it waits, and no bound beats any", () => {
    const seen: (number | undefined)[] = [];
    const q = new RefreshQueue((s) => void seen.push(s.since), (work) => work(), 1);
    q.queue([span(0), { ...span(1), since: 9 }, { ...span(2), since: 5 }]);
    q.queue([{ ...span(1), since: 4 }, span(2)]);
    q.stop();
    q.flush();
    expect(seen).toEqual([undefined, 4, undefined]);
  });
});
