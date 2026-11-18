import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listCloudTraces } from "../src/ingest/importers/neatlogs-cloud.js";
import { batch, hex, makeRoots, s, span, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A second host that records the headers it gets and answers like a happy ingest or API. */
async function target(): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const url = await listen((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { traces: [], page: { hasMore: false, nextCursor: null } } })));
  });
  return { url, seen };
}

/** The configured endpoint: answers every request with a 302 to the other host. */
const redirector = (to: string) =>
  listen((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(302, { location: `${to}${req.url}` }).end());
  });

describe("requests carrying Neatlogs Cloud credentials don't follow redirects", () => {
  it("a forward to an endpoint that redirects fails, and the key never reaches the other host", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", "{}", "{}"), span({ traceId: t, spanId: root, name: "agent", kind: "workflow", attrs: [s("neatlogs.session.id", "s1")] })])]);
    const other = await target();
    const endpoint = await redirector(other.url);

    const row = await tb.roots.relay.forward([t], "test", { endpoint, apiKey: "nl-secret-project-key" });
    expect(other.seen).toHaveLength(0);
    expect(row.status).toBe("error");
    expect(row.http_status).toBe(302);
    expect(row.error).toMatch(/redirect/i);
    expect(tb.roots.store.forwardedTraceIds().size).toBe(0);
  });

  it("a cloud import from an API that redirects fails, and the token never reaches the other host", async () => {
    const other = await target();
    const base = await redirector(other.url);
    await expect(listCloudTraces(base, { token: "nlsa_secret-token", projectId: "p1" })).rejects.toThrow(/redirect/i);
    expect(other.seen).toHaveLength(0);
  });
});
