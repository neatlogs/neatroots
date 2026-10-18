import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, makeRoots, s, span, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** An OTLP endpoint that only counts the requests it gets. */
async function sink(): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => n };
}

describe("forwarding a run id that isn't stored", () => {
  it("fails without sending anything, instead of reporting an empty send as ok", async () => {
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(tb.close);
    const t = hex(16);
    const root = hex(8);
    tb.roots.ingest([batch([toolSpan(t, root, "lookup_order", "{}", "{}"), span({ traceId: t, spanId: root, name: "agent", kind: "workflow", attrs: [s("neatlogs.session.id", "s1")] })])]);
    const out = await sink();

    for (const id of [t.slice(0, 8), hex(16)]) {
      const row = await tb.roots.relay.forward([id], "test", { endpoint: out.url, apiKey: "nl-test-key" });
      expect(row.status).toBe("error");
      expect(row.error).toBe(`no run with id ${id}`);
    }
    // One unknown id fails the whole send, so the run it came with is not sent half-labelled.
    const mixed = await tb.roots.relay.forward([t, "nope"], "test", { endpoint: out.url, apiKey: "nl-test-key" });
    expect(mixed.error).toBe("no run with id nope");
    expect(out.requests()).toBe(0);
    expect(tb.roots.store.forwardedTraceIds().size).toBe(0);

    // The full id still goes through.
    const ok = await tb.roots.relay.forward([t], "test", { endpoint: out.url, apiKey: "nl-test-key" });
    expect(ok.status).toBe("ok");
    expect(ok.span_count).toBe(2);
    expect(out.requests()).toBeGreaterThan(0);
  });
});
