import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import { decodeTraceProtobuf } from "../src/otlp/codec.js";
import { batch, freePort, hex, s, span, tmpHome, toolSpan } from "./helpers.js";

// Auto-forward ("Every finished run of a project", docs/cloud.md) must survive a failed send and a
// restart: a run that finished while forwarding was on reaches Neatlogs Cloud once, unless the
// person turns forwarding off first.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.NEATLOGS_CLOUD_API_KEY;
  for (const c of cleanup.splice(0).reverse()) await c();
});

/**
 * A Neatlogs ingest that answers each request with the next status in `statuses` (the last one
 * repeats), after `delayMs`, keeping each request body in `bodies` if given.
 */
async function cloud(statuses: number[], delayMs = 0, bodies?: Buffer[]): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      bodies?.push(Buffer.concat(chunks));
      const status = statuses[Math.min(n++, statuses.length - 1)];
      setTimeout(() => res.writeHead(status).end(), delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => n };
}

async function open(home: string, endpoint: string): Promise<Roots> {
  const cfg = defaultConfig();
  cfg.port = await freePort();
  cfg.llm.enabled = false;
  cfg.classifier.backend = "llm";
  cfg.classifier.laya.enabled = false;
  cfg.cloud.endpoint = endpoint;
  cfg.projects["test-agent"] = { forward: true };
  const roots = new Roots({ home, config: cfg, noEngine: true });
  // Wait and retry in milliseconds rather than seconds.
  roots.relay.settleMs = 20;
  roots.relay.retryBaseMs = 20;
  return roots;
}

function newHome(): string {
  const home = tmpHome();
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A run of the test-agent project whose root span has ended. */
function finishRun(roots: Roots): string {
  const t = hex(16);
  const root = hex(8);
  roots.ingest([batch([toolSpan(t, root, "lookup_order", "{}", "{}"), span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })])]);
  return t;
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = () => new Promise((r) => setTimeout(r, 300));
const statuses = (roots: Roots) => roots.store.listForwards().map((f) => `${f.status}:${f.http_status ?? "-"}`).reverse();
const queue = (roots: Roots) =>
  roots.store.db.prepare("SELECT trace_id, attempts, next_ms, claimed_until FROM auto_forwards").all() as { trace_id: string; attempts: number; next_ms: number; claimed_until: number | null }[];

/** Unhandled rejections from now until the test ends. */
function watchRejections(): unknown[] {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", on);
  cleanup.push(() => void process.off("unhandledRejection", on));
  return seen;
}

it("retries a run whose auto-forward failed with a 5xx, and sends it once", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503, 200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  await until(() => roots.store.forwardedTraceIds().has(t));
  await settled();
  expect(statuses(roots)).toEqual(["error:503", "ok:200"]);
});

it("doesn't retry a failure that won't pass on its own (a rejected key)", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([401]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  finishRun(roots);
  await until(() => roots.store.listForwards().length > 0);
  await settled();
  expect(c.requests()).toBe(1);
  expect(statuses(roots)).toEqual(["error:401"]);
});

it("stops after six sends when ingest keeps failing, and drops the run from the queue", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.retryBaseMs = 5;
  finishRun(roots);
  await until(() => queue(roots).length === 0 && c.requests() > 0);
  await settled();
  expect(c.requests()).toBe(6);
  expect(statuses(roots)).toEqual(Array(6).fill("error:503"));
});

it("keeps the attempt count and the next try in the store, doubling the wait", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.retryBaseMs = 10_000;
  const before = Date.now();
  finishRun(roots);
  await until(() => queue(roots)[0]?.attempts === 1);
  const row = queue(roots)[0];
  expect(row.next_ms - before).toBeGreaterThanOrEqual(10_000);
  expect(row.next_ms - Date.now()).toBeLessThanOrEqual(10_000);
  expect(row.claimed_until).toBeNull();
});

it("sends a run that waits in back-off after a restart, keeping its attempt count", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503, 200]);
  const home = newHome();
  const first = await open(home, c.url);
  first.relay.retryBaseMs = 60_000;
  const t = finishRun(first);
  await until(() => queue(first)[0]?.attempts === 1);
  first.close();

  const second = await open(home, c.url);
  cleanup.push(() => second.close());
  second.relay.resume();
  await until(() => second.store.forwardedTraceIds().has(t));
  expect(queue(second)).toEqual([]);
  expect(statuses(second)).toEqual(["error:503", "ok:200"]);
});

it("sends a queued run once when two neatroots share the store", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200], 300);
  const home = newHome();
  const a = await open(home, c.url);
  const b = await open(home, c.url);
  cleanup.push(() => a.close(), () => b.close());
  a.relay.settleMs = 100;
  const t = finishRun(a);
  b.relay.resume();
  await until(() => a.store.forwardedTraceIds().has(t));
  await new Promise((r) => setTimeout(r, 800));
  expect(statuses(a)).toEqual(["ok:200"]);
  expect(c.requests()).toBe(2); // the spans, then the completion marker
});

it("backs off after an unexpected error instead of retrying in a tight loop", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.retryBaseMs = 100;
  let calls = 0;
  const real = roots.store.wasForwarded.bind(roots.store);
  roots.store.wasForwarded = (id: string) => {
    // The first look is when the run is queued; every later one is a send.
    if (++calls > 1) throw new Error("store hiccup");
    return real(id);
  };
  const t = finishRun(roots);
  await new Promise((r) => setTimeout(r, 400));
  expect(calls).toBeLessThanOrEqual(4);
  expect(queue(roots)[0]?.attempts).toBeGreaterThanOrEqual(1);
  roots.store.wasForwarded = real;
  await until(() => roots.store.forwardedTraceIds().has(t));
});

it("sends a run that a restart interrupted before it was forwarded", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const home = newHome();
  const first = await open(home, c.url);
  first.relay.settleMs = 60_000; // still waiting when neatroots stops
  const t = finishRun(first);
  first.close();
  expect(c.requests()).toBe(0);

  const second = await open(home, c.url);
  cleanup.push(() => second.close());
  second.relay.resume?.();
  await until(() => second.store.forwardedTraceIds().has(t));
  await settled();
  expect(statuses(second)).toEqual(["ok:200"]);
});

it("doesn't touch the store after neatroots closes with a forward still waiting", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  roots.relay.settleMs = 100;
  const rejections = watchRejections();
  finishRun(roots);
  roots.close();
  // Past the longest wait before a send, old or new.
  await new Promise((r) => setTimeout(r, 2000));
  expect(rejections).toEqual([]);
  expect(c.requests()).toBe(0);
});

it("drops a queued run when forwarding is turned off before it is sent", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 200;
  finishRun(roots);
  roots.config.projects["test-agent"] = { forward: false };
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});

it("stops in back-off when neatroots closes: no send, no error, still queued for the next start", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503]);
  const home = newHome();
  const roots = await open(home, c.url);
  roots.relay.retryBaseMs = 300;
  const rejections = watchRejections();
  finishRun(roots);
  await until(() => queue(roots)[0]?.attempts === 1);
  roots.close();
  await new Promise((r) => setTimeout(r, 800));
  expect(c.requests()).toBe(1);
  expect(rejections).toEqual([]);
  const again = await open(home, c.url);
  cleanup.push(() => again.close());
  expect(queue(again)).toHaveLength(1);
});

it("closes cleanly with a request in flight, and leaves the run released for the next start", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200], 400);
  const home = newHome();
  const roots = await open(home, c.url);
  const rejections = watchRejections();
  finishRun(roots);
  await until(() => c.requests() === 1);
  roots.close();
  await new Promise((r) => setTimeout(r, 1200));
  expect(rejections).toEqual([]);
  // Cloud may have the run already; the next start sends it again (at-least-once, docs/cloud.md).
  const again = await open(home, c.url);
  cleanup.push(() => again.close());
  expect(queue(again)).toEqual([expect.objectContaining({ attempts: 0, claimed_until: null })]);
});

it("doesn't send a run an import replaced under the same trace id, or a deleted run imported again", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 300;
  const imported = (traceId: string, spanId: string) => {
    const b = batch([span({ traceId, spanId, name: "agent", kind: "workflow" })]);
    b.resource.attributes.push(s("neatroots.import.source", "file"));
    return b;
  };
  const replaced = hex(16);
  const root1 = hex(8);
  roots.ingest([batch([span({ traceId: replaced, spanId: root1, name: "agent", kind: "workflow" })])]);
  roots.ingest([imported(replaced, root1)]);
  const reimported = hex(16);
  const root2 = hex(8);
  roots.ingest([batch([span({ traceId: reimported, spanId: root2, name: "agent", kind: "workflow" })])]);
  roots.store.deleteRun(reimported);
  roots.ingest([imported(reimported, root2)]);
  expect(queue(roots).map((q) => q.trace_id).sort()).toEqual([replaced, reimported].sort());
  await until(() => queue(roots).length === 0);
  await settled();
  expect(c.requests()).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});

it("drops a run in back-off when forwarding is turned off", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([503, 200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.retryBaseMs = 200;
  finishRun(roots);
  await until(() => queue(roots)[0]?.attempts === 1);
  roots.config.projects["test-agent"] = { forward: false };
  await until(() => queue(roots).length === 0);
  await settled();
  expect(c.requests()).toBe(1);
});

it("a retry sends the run as stored now: current endpoint, redacted", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const failing = await cloud([503]);
  const bodies: Buffer[] = [];
  const good = await cloud([200], 0, bodies);
  const roots = await open(newHome(), failing.url);
  cleanup.push(() => roots.close());
  roots.relay.retryBaseMs = 200;
  const t = hex(16);
  const root = hex(8);
  const secret = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  roots.ingest([batch([toolSpan(t, root, "read_env", "{}", `OPENAI_API_KEY=${secret}`), span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })])]);
  await until(() => queue(roots)[0]?.attempts === 1);
  roots.config.cloud.endpoint = good.url;
  await until(() => roots.store.forwardedTraceIds().has(t));
  expect(failing.requests()).toBe(1);
  const spans = decodeTraceProtobuf(zlib.gunzipSync(bodies[0])).flatMap((b) => b.spans);
  const text = JSON.stringify(spans);
  expect(text).not.toContain(secret);
  expect(text).toContain("[redacted:api_key]");
});

it("never auto-forwards an imported run (docs/cloud.md)", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = hex(16);
  const root = hex(8);
  const imported = batch([span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })]);
  imported.resource.attributes.push(s("neatroots.import.source", "file"));
  roots.ingest([imported]);
  expect(roots.store.getRun(t)?.project).toBe("test-agent");
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});

it("still auto-forwards a run sent live through the HTTP trace API", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = hex(16);
  const live = batch([span({ traceId: t, spanId: hex(8), name: "agent", kind: "workflow" })]);
  live.resource.attributes.push(s("neatroots.import.source", "http"));
  roots.ingest([live]);
  await until(() => roots.store.forwardedTraceIds().has(t));
});

it("doesn't send a run while it is being sent by hand (Cloud slow to answer)", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  // Each request takes 600 ms, so the queued auto-forward comes due while the send by hand waits.
  const c = await cloud([200], 600);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  const byHand = roots.relay.forward([t], "user");
  expect((await byHand).status).toBe("ok");
  await until(() => queue(roots).length === 0, 5000);
  await settled();
  expect(c.requests()).toBe(2); // its spans and its marker, once (was 4: auto-forward sent it too)
  expect(statuses(roots)).toEqual(["ok:200"]);
});

it("still auto-forwards a run whose send by hand failed while it waited", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  // The send by hand gets a 400 (not retried); the auto-forward that waited for it then sends the run.
  const c = await cloud([400, 200], 400);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  expect((await roots.relay.forward([t], "user")).status).toBe("error");
  await until(() => roots.store.forwardedTraceIds().has(t), 5000);
  expect(statuses(roots)).toEqual(["error:400", "ok:200"]);
  expect(queue(roots)).toEqual([]);
});

it("doesn't send a run by hand again while its auto-forward is under way (Cloud slow to answer)", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200], 600);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  // The auto-forward has posted its spans and waits for Cloud; then Send is clicked.
  await until(() => c.requests() >= 1, 5000);
  const byHand = await roots.relay.forward([t], "user");
  expect(byHand.status).toBe("ok");
  await settled();
  expect(c.requests()).toBe(2); // its spans and its marker, once (was 4)
  expect(statuses(roots)).toEqual(["ok:200"]);
});

it("answers a send by hand of several runs, each just auto-forwarded on its own, with one record of them all", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200], 600);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t1 = finishRun(roots);
  const t2 = finishRun(roots);
  // Both auto-forwards (one per run) have posted and wait for Cloud; then both runs are sent by hand.
  await until(() => c.requests() >= 2, 5000);
  const row = await roots.relay.forward([t1, t2], "user");
  await settled();
  expect(c.requests()).toBe(4); // each run's spans and marker, once
  // One stored record covering both runs (was only the first run's auto-forward), noting what sent them.
  expect(row).toMatchObject({ status: "ok", bytes: 0, span_count: 0 });
  expect([...row.trace_ids].sort()).toEqual([t1, t2].sort());
  const autos = roots.store.listForwards().filter((f) => f.initiated_by === "auto");
  expect(autos).toHaveLength(2);
  for (const a of autos) expect(row.error).toContain(a.id);
  expect(roots.store.listForwards().map((f) => f.id)).toContain(row.id);
});

it("still sends a run by hand to another endpoint than the one its auto-forward just used", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const a = await cloud([200], 400);
  const b = await cloud([200]);
  const roots = await open(newHome(), a.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  const u = finishRun(roots);
  // Both runs' auto-forwards to A are under way; then both runs are sent by hand to B.
  await until(() => a.requests() >= 2, 5000);
  const row = await roots.relay.forward([t, u], "user", { endpoint: b.url });
  // B got them (was: told they were sent, with nothing reaching B).
  expect(row).toMatchObject({ status: "ok", endpoint: b.url });
  expect(b.requests()).toBe(2); // one request with both runs' spans, one with their markers
  expect([...row.trace_ids].sort()).toEqual([t, u].sort());
});

it("sends a run by hand when the auto-forward it waited for failed", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  // The auto-forward gets a 400 (not retried); the send by hand that waited for it then goes.
  const c = await cloud([400, 200], 400);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  const t = finishRun(roots);
  await until(() => c.requests() >= 1, 5000);
  expect((await roots.relay.forward([t], "user")).status).toBe("ok");
  expect(statuses(roots)).toEqual(["error:400", "ok:200"]);
  expect(c.requests()).toBe(3);
});

it("doesn't send a run again that was already sent by hand", async () => {
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const c = await cloud([200]);
  const roots = await open(newHome(), c.url);
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 200;
  const t = finishRun(roots);
  expect((await roots.relay.forward([t], "user")).status).toBe("ok");
  const sent = c.requests();
  await new Promise((r) => setTimeout(r, 2000));
  expect(c.requests()).toBe(sent);
  expect(statuses(roots)).toEqual(["ok:200"]);
});
