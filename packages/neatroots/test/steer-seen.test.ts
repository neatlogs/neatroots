import { afterEach, describe, expect, it } from "vitest";
import { hex, makeRoots } from "./helpers.js";
import { steeringHook, since } from "../src/cli/util.js";

// `hooks_connected` is the SSE subscriber count, and only the Python hook streams. The TypeScript
// hook polls /api/steer/claim, so for a TypeScript project the number read 0 whether the hook was
// wired up or not, and nothing else could tell you either.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function served() {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  return tb;
}

const status = async (url: string) => (await (await fetch(`${url}/api/status`)).json()) as { steering: { enabled: boolean; hooks_connected: number; last_seen_ms: number | null; last_project: string | null } };

async function claim(tb: Awaited<ReturnType<typeof served>>, traceId: string, project?: string) {
  return fetch(`${tb.url}/api/steer/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trace_id: traceId, project }),
  });
}

describe("whether a steering hook is actually talking to neatroots", () => {
  it("starts with no hook seen, which is not the same as zero connections", async () => {
    const tb = await served();
    expect((await status(tb.url)).steering).toMatchObject({ hooks_connected: 0, last_seen_ms: null, last_project: null });
  });

  it("records a polling hook (the TypeScript one) even though it never streams", async () => {
    const tb = await served();
    const before = Date.now();
    await claim(tb, hex(16), "test-agent");
    const s = await status(tb.url);
    // The count stays 0: nothing subscribed. Last contact is what says the hook is alive.
    expect(s.steering.hooks_connected).toBe(0);
    expect(s.steering.last_seen_ms).toBeGreaterThanOrEqual(before);
    expect(s.steering.last_project).toBe("test-agent");
  });

  it("records a hook asking about a run neatroots has not seen yet", async () => {
    const tb = await served();
    // No span has arrived, so the route answers mode unknown: the hook is still talking to us.
    const r = await claim(tb, hex(16));
    expect(await r.json()).toEqual({ mode: "unknown", known: false, note: null });
    expect((await status(tb.url)).steering.last_seen_ms).not.toBeNull();
  });

  it("records the project of the run when the hook does not name one", async () => {
    const tb = await served();
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batchWithProject(t, root, "refund-agent")]);
    await claim(tb, t);
    expect((await status(tb.url)).steering.last_project).toBe("refund-agent");
  });

  it("moves the timestamp forward on the next ask", async () => {
    const tb = await served();
    await claim(tb, hex(16), "a");
    const first = (await status(tb.url)).steering.last_seen_ms!;
    await new Promise((r) => setTimeout(r, 5));
    await claim(tb, hex(16), "b");
    const s = await status(tb.url);
    expect(s.steering.last_seen_ms!).toBeGreaterThanOrEqual(first);
    expect(s.steering.last_project).toBe("b");
  });

  it("keeps the last named project when a later hook does not name one", async () => {
    const tb = await served();
    // The Python hook opens the stream without a project, so a stream subscribe after a claim must
    // move the time without blanking the project the status line was showing.
    await claim(tb, hex(16), "hookcheck");
    expect((await status(tb.url)).steering.last_project).toBe("hookcheck");

    const ctrl = new AbortController();
    const res = await fetch(`${tb.url}/api/steer/stream`, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    try {
      const s = await status(tb.url);
      expect(s.steering.hooks_connected).toBe(1);
      expect(s.steering.last_project).toBe("hookcheck");
      expect(s.steering.last_seen_ms).toBeGreaterThan(0);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    }

    // A hook that does name a project still updates it.
    await claim(tb, hex(16), "other-project");
    expect((await status(tb.url)).steering.last_project).toBe("other-project");
  });

  it("counts a streaming client and records it too", async () => {
    const tb = await served();
    const ctrl = new AbortController();
    const res = await fetch(`${tb.url}/api/steer/stream`, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    try {
      // The Python hook is the one that streams.
      const s = await status(tb.url);
      expect(s.steering.hooks_connected).toBe(1);
      expect(typeof s.steering.last_seen_ms).toBe("number");
      expect(s.steering.last_seen_ms).toBeGreaterThan(0);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});

describe("the doctor's steering line", () => {
  it("says a hook has never asked, and names the count as stream clients", () => {
    const line = steeringHook(null, null, 0);
    expect(line).toMatch(/no steering hook has asked yet/);
    expect(line).toMatch(/is the hook in place\?/);
    expect(line).toMatch(/0 streaming clients \(Python\)/);
  });

  it("says when a hook last asked and which project, with no streaming client", () => {
    const line = steeringHook(Date.now() - 4000, "test-agent", 0);
    expect(line).toMatch(/last hook asked 4s ago \(test-agent\)/);
    // A TypeScript project has no streaming client and is still reported as connected.
    expect(line).toMatch(/0 streaming clients \(Python\)/);
    expect(line).not.toMatch(/is the hook in place/);
  });

  it("formats the gap in the unit that reads best", () => {
    expect(since(Date.now() - 5_000)).toBe("5s ago");
    expect(since(Date.now() - 3 * 60_000)).toBe("3m ago");
    expect(since(Date.now() - 2 * 3_600_000)).toBe("2h ago");
    expect(since(Date.now() - 3 * 86_400_000)).toBe("3d ago");
  });
});

function batchWithProject(traceId: string, spanId: string, project: string) {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: project } }] },
    scope: { name: "test" },
    spans: [
      {
        traceId,
        spanId,
        name: "agent",
        kind: 1,
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: [{ key: "neatlogs.span.kind", value: { stringValue: "workflow" } }],
        events: [],
        links: [],
        status: { code: 1 },
      },
    ],
  };
}
