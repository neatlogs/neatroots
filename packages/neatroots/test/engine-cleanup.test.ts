import { afterEach, expect, it, vi } from "vitest";
import { batch, hex, makeRoots, mockLlm, s, span, until } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function finished() {
  const llm = await mockLlm(); cleanup.push(llm.close);
  const t = await makeRoots({ llmUrl: llm.url }); cleanup.push(t.close);
  const callbacks: (() => void)[] = [], timers: NodeJS.Timeout[] = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = original(fn, ms, ...args);
    if (ms === 60_000) { callbacks.push(() => fn(...args)); timers.push(timer); }
    return timer;
  }) as typeof setTimeout);
  cleanup.push(() => { for (const timer of timers) clearTimeout(timer); });
  const trace = hex(16);
  t.roots.ingest([batch([span({ traceId: trace, name: "finished", kind: "workflow", attrs: [s("neatlogs.workflow.input", "Task"), s("neatlogs.workflow.output", "Done")] })])]);
  await until(() => t.roots.checkCompletion.state(trace) === "settled");
  const engine = t.roots.engine!;
  // Use the real scheduler/receipt path with controlled accepted work after the end pass.
  const internal = engine as unknown as { live: Map<string, { completionGeneration: string; spanQueue: Map<string, string[]> }>;
    track(id: string, promise: Promise<void>, generation: string): Promise<unknown> };
  expect(callbacks).toHaveLength(1);
  return { t, trace, engine, internal, callbacks, timers };
}

it("retries eviction after a slow accepted job and preserves its settled receipt", async () => {
  const { t, trace, engine, internal, callbacks, timers } = await finished();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }); cleanup.push(() => release());
  const job = internal.track(trace, gate, internal.live.get(trace)!.completionGeneration);
  callbacks[0]();
  expect(internal.live.has(trace)).toBe(true);
  expect(callbacks).toHaveLength(2);
  expect(timers[1].hasRef()).toBe(false);
  release(); await job;
  expect(t.roots.checkCompletion.state(trace)).toBe("settled");
  callbacks[1]();
  expect(internal.live.has(trace)).toBe(false);
  expect(engine.pending(trace)).toBe(0);
  expect(t.roots.checkCompletion.state(trace)).toBe("settled");
});

it("evicts an abandoned queue without turning its failed receipt into success", async () => {
  const { t, trace, engine, internal, callbacks } = await finished();
  const run = internal.live.get(trace)!;
  run.spanQueue.set("accepted", [hex(8)]);
  await internal.track(trace, Promise.reject(new Error("controlled worker rejection")), run.completionGeneration);
  expect(engine.pending(trace)).toBeGreaterThan(0);
  expect(t.roots.checkCompletion.state(trace)).toBe("failed");
  callbacks[0]();
  expect(internal.live.has(trace)).toBe(false);
  expect(engine.pending(trace)).toBe(0);
  expect(t.roots.checkCompletion.state(trace)).toBe("failed");
  expect(engine.progress.state(trace)).toBe("interrupted");
  await engine.recheck(trace);
  expect(t.roots.checkCompletion.state(trace)).toBe("settled");
});

it("an old cleanup callback cannot evict a replacement recheck run", async () => {
  const { trace, engine, internal, callbacks } = await finished();
  const old = internal.live.get(trace);
  await engine.recheck(trace);
  const replacement = internal.live.get(trace);
  expect(replacement).not.toBe(old);
  callbacks[0]();
  expect(internal.live.get(trace)).toBe(replacement);
  callbacks[1]();
  expect(internal.live.has(trace)).toBe(false);
});

it("shutdown cancels owned cleanup timers and callbacks cannot rearm them", async () => {
  const { t, callbacks, timers } = await finished();
  const clear = vi.spyOn(globalThis, "clearTimeout");
  t.roots.close();
  expect(clear).toHaveBeenCalledWith(timers[0]);
  callbacks[0]();
  expect(callbacks).toHaveLength(1);
});
