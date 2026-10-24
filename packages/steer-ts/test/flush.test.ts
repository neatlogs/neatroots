import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMyWork, configure, guidance } from "../src/index.js";

// Before a claim (gate or a new run) and before a self-check, the hook flushes the Neatlogs SDK so
// neatroots sees the latest step. A neatroots that takes the connection but doesn't answer holds
// the SDK's flush for about 10 s while it retries, and that must not hold up the agent's LLM call.

const trace = "c".repeat(32);
const events: string[] = [];
const claim = vi.fn(async (url: unknown) => {
  events.push(String(url).endsWith("/api/steer/check") ? "check" : "claim");
  return String(url).endsWith("/api/steer/check")
    ? Response.json({ answer: "no", probability: 0.1, evidence_span_ids: [] })
    : Response.json({ mode: "advisory", note: null });
});

/** An SDK whose flush takes `ms` (or fails), recording when it starts and ends. */
function sdk(ms: number, fail = false) {
  const flush = vi.fn(async () => {
    events.push("flush start");
    await new Promise((r) => setTimeout(r, ms));
    events.push("flush end");
    if (fail) throw new Error("collector unreachable");
  });
  configure({ disabled: false, neatlogs: { flush } });
  return flush;
}

async function timed<T>(fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

beforeEach(() => {
  events.length = 0;
  claim.mockClear();
  vi.stubGlobal("fetch", claim);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("flushing the SDK before a claim or a self-check", () => {
  it("holds guidance() at most about half a second when the flush hangs", async () => {
    sdk(3000);
    // was: the whole 3 s, on every LLM call
    expect(await timed(() => guidance(trace))).toBeLessThan(1000);
    expect(claim).toHaveBeenCalledOnce();
  });

  it("holds checkMyWork() at most about half a second when the flush hangs", async () => {
    sdk(3000);
    expect(await timed(() => checkMyWork("Did the refund go through?", { traceId: trace }))).toBeLessThan(1000);
    expect(events).toContain("check");
  });

  it("doesn't start another flush while one is still running", async () => {
    const flush = sdk(3000);
    await guidance(trace);
    configure({ disabled: false }); // a new run asks again, as after a mode change
    await guidance(trace);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("still finishes a quick flush before the claim is sent", async () => {
    sdk(50);
    await guidance(trace);
    expect(events).toEqual(["flush start", "flush end", "claim"]);
  });

  it("carries on when the flush fails", async () => {
    sdk(10, true);
    await expect(guidance(trace)).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("keeps a running flush when configure() is given the same SDK, and starts one for a new SDK", async () => {
    const flush = vi.fn(() => new Promise<void>(() => {}));
    const same = { flush };
    configure({ disabled: false, neatlogs: same });
    await guidance(trace);
    configure({ disabled: false, neatlogs: same });
    await guidance(trace);
    expect(flush).toHaveBeenCalledOnce();
    const other = vi.fn(async () => undefined);
    configure({ disabled: false, neatlogs: { flush: other } });
    await guidance(trace);
    expect(other).toHaveBeenCalledOnce();
  });

  it("tracks each SDK's running flush, so switching SDKs and back doesn't flush the first one twice", async () => {
    const a = { flush: vi.fn(() => new Promise<void>(() => {})) };
    const b = { flush: vi.fn(() => new Promise<void>(() => {})) };
    for (const s of [a, b, a]) {
      configure({ disabled: false, neatlogs: s });
      await guidance(trace);
    }
    expect(a.flush).toHaveBeenCalledOnce();
    expect(b.flush).toHaveBeenCalledOnce();
  });

  it("keeps the process alive while it waits, so a short-lived agent still gets to its claim", async () => {
    // A flush that never settles and holds nothing open: only the wait's own timer is left.
    configure({ disabled: false, neatlogs: { flush: () => new Promise<void>(() => {}) } });
    const real = globalThis.setTimeout;
    const timers: { ms: number | undefined; t: ReturnType<typeof setTimeout> }[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      timers.push({ ms, t });
      return t;
    }) as typeof setTimeout);
    const pending = guidance(trace);
    await new Promise((r) => setImmediate(r));
    const wait = timers.find((x) => x.ms === 500);
    expect(wait).toBeDefined();
    expect((wait!.t as { hasRef?: () => boolean }).hasRef?.()).toBe(true);
    await pending;
    expect(claim).toHaveBeenCalledOnce();
  });
});
