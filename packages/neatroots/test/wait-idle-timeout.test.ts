import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "../src/engine/engine.js";
import { hex, makeRoots } from "./helpers.js";

/** Private fields exercised by #215 (waitIdle timeout must not leave stale waiters). */
type EnginePriv = Engine & {
  jobs: Map<string, number>;
  idleWaiters: Map<string, (() => void)[]>;
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("Engine.waitIdle (#215)", () => {
  it("drops timed-out waiters from idleWaiters so scheduleFlush debounce is not stuck at 0", async () => {
    const tb = await makeRoots();
    cleanup.push(tb.close);
    const engine = tb.roots.engine!;
    const traceId = hex(16);
    const priv = engine as EnginePriv;
    // Simulate a check job still running so waitIdle waits, then times out (no ingest → no async track).
    priv.jobs.set(traceId, 1);

    expect(await engine.waitIdle(traceId, 5)).toBe(false);

    expect(priv.idleWaiters.has(traceId)).toBe(false);
  });
});
