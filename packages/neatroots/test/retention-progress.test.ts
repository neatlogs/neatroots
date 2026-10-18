import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { Store } from "../src/store/db.js";
import { Retention } from "../src/retention.js";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 0); return 0; });
  } };
});
type Harness = {
  open(): void;
  request<T>(type: string): Promise<T>;
  worker: EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
  pending: Map<number, unknown>;
};
function setup() {
  vi.useFakeTimers();
  const retention = new Retention({ dir: "/unused" } as Store);
  const harness = retention as unknown as Harness;
  harness.open();
  return { retention, harness, worker: harness.worker };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("allows healthy matching progress beyond 90 seconds total", async () => {
  const { harness, worker } = setup();
  const result = harness.request<number>("collectIndex");
  await vi.advanceTimersByTimeAsync(60_000);
  worker.emit("message", { id: 1, progress: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.emit("message", { id: 1, value: 7 });
  await expect(result).resolves.toBe(7);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(harness.pending.size).toBe(0);
});

it("does not let progress refresh another pending request", async () => {
  const { harness, worker } = setup();
  const first = harness.request("initialize");
  const firstRejected = expect(first).rejects.toThrow("initialize timed out");
  const second = harness.request("collectIndex");
  const secondRejected = expect(second).rejects.toThrow("worker exited");
  await vi.advanceTimersByTimeAsync(60_000);
  worker.emit("message", { id: 2, progress: true });
  worker.emit("message", { id: 999, progress: true });
  worker.emit("message", { progress: true });
  await vi.advanceTimersByTimeAsync(30_000);
  await firstRejected; await secondRejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("ignores completed IDs and obsolete worker progress and exit", async () => {
  const { harness, worker: obsolete } = setup();
  const completed = harness.request("initialize");
  obsolete.emit("message", { id: 1, value: null }); await completed;
  harness.open(); const current = harness.worker;
  const result = harness.request("collectIndex");
  const rejected = expect(result).rejects.toThrow("collectIndex timed out");
  await vi.advanceTimersByTimeAsync(60_000);
  current.emit("message", { id: 1, progress: true });
  obsolete.emit("message", { id: 2, progress: true });
  obsolete.emit("exit", 1);
  expect(harness.pending.size).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(current.terminate).toHaveBeenCalledTimes(1);
});

it.each(["error", "exit", "close"])("cancels timers on %s without delayed termination", async (event) => {
  const { retention, harness, worker } = setup();
  const result = harness.request("initialize");
  const rejected = expect(result).rejects.toThrow();
  if (event === "close") await retention.close();
  else if (event === "error") worker.emit("error", new Error("worker failure"));
  else worker.emit("exit", 1);
  await rejected;
  const terminations = worker.terminate.mock.calls.length;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(worker.terminate).toHaveBeenCalledTimes(terminations);
  expect(harness.pending.size).toBe(0);
});
