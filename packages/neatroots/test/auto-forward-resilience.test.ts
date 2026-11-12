import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, until } from "./helpers.js";

// The auto-forward queue lives in the store, next to everything else ingest writes. When the store
// can't take its writes, auto-forward gives up on that run; ingest, the checks and shutdown carry on.
// And a backlog (a restart after Cloud was down, say) goes out a few runs at a time.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.NEATLOGS_CLOUD_API_KEY;
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A Cloud ingest that answers 200 after `delayMs`, counting requests and how many are open at once. */
async function cloud(delayMs: number) {
  const seen = { requests: 0, inFlight: 0, maxInFlight: 0 };
  const server = http.createServer((req, res) => {
    seen.requests++;
    seen.inFlight++;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    req.resume();
    req.on("end", () =>
      setTimeout(() => {
        seen.inFlight--;
        res.writeHead(200).end();
      }, delayMs),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

function finishedRun(t: string) {
  const root = hex(8);
  return [batch([llmSpan(t, root, { system: "s", user: "hi", out: "ok" }), span({ traceId: t, spanId: root, name: "agent", kind: "workflow" }), markerSpan(t, root)])];
}

const queued = (db: { prepare: (sql: string) => { get: () => unknown } }) => (db.prepare("SELECT COUNT(*) AS n FROM auto_forwards").get() as { n: number }).n;

it("stores a finished run and checks it when it can't be queued for auto-forward", async () => {
  const c = await cloud(0);
  const llm = await mockLlm({});
  cleanup.push(() => llm.close());
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const tb = await makeRoots({ llmUrl: llm.url, config: (x) => ((x.cloud.endpoint = c.url), (x.projects["test-agent"] = { forward: true })) });
  cleanup.push(tb.close);
  // The queue can't be written: stands in for a busy, full or read-only store.
  tb.roots.store.db.exec("DROP TABLE auto_forwards");
  const t = hex(16);
  // Used to throw after the spans were stored, so the checks never saw the run end.
  expect(() => tb.roots.ingest(finishedRun(t))).not.toThrow();
  expect(tb.roots.store.getRun(t)?.span_count).toBe(2);
  await until(() => tb.roots.store.getSummary(t), 8000);
});

it("stops neatroots when a send is under way and its claim can't be released", async () => {
  const c = await cloud(2000);
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const tb = await makeRoots({ noEngine: true, config: (x) => ((x.cloud.endpoint = c.url), (x.projects["test-agent"] = { forward: true })) });
  cleanup.push(tb.close);
  tb.roots.relay.settleMs = 10;
  tb.roots.ingest(finishedRun(hex(16)));
  await until(() => c.seen.inFlight > 0, 5000);
  tb.roots.store.db.exec("DROP TABLE auto_forwards");
  // Used to throw before Laya was stopped and the store closed.
  expect(() => tb.roots.close()).not.toThrow();
  expect(tb.roots.store.db.open).toBe(false);
});

it("sends a backlog a few runs at a time after a restart, without spinning while it waits", async () => {
  const c = await cloud(300);
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const tb = await makeRoots({ noEngine: true, config: (x) => ((x.cloud.endpoint = c.url), (x.projects["test-agent"] = { forward: true })) });
  cleanup.push(tb.close);
  // Forty finished runs wait in the queue, as after a restart.
  tb.roots.relay.settleMs = 60_000;
  for (let i = 0; i < 40; i++) tb.roots.ingest(finishedRun(hex(16)));
  expect(queued(tb.roots.store.db)).toBe(40);
  const drains = vi.spyOn(tb.roots.relay as unknown as { drain: () => void }, "drain");
  tb.roots.relay.settleMs = 10;
  tb.roots.relay.resume();
  await until(() => queued(tb.roots.store.db) === 0, 20_000);
  expect(c.seen.requests).toBe(80); // every run, its spans and its marker
  expect(c.seen.maxInFlight).toBeLessThanOrEqual(4); // was 40
  // The queue is drained when a send ends, not on a timer that fires while every slot is busy.
  expect(drains.mock.calls.length).toBeLessThan(200);
});
