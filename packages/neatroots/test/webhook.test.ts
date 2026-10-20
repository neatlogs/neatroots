import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/bus.js";
import type { Finding, Note } from "../src/types.js";
import { WebhookDispatcher } from "../src/webhook/dispatcher.js";
import { parseWebhooks, maskedWebhookUrl } from "../src/webhook/config.js";
import { webhookPayload } from "../src/webhook/payload.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function receiver(handler?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const bodies: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    bodies.push(body); if (handler) handler(req, res, body); else res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return { bodies, url: "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/TOKEN?secret=QUERY" };
}
const finding = (id = "f1", status = "raised"): Finding => ({ id, trace_id: "trace1", check_id: "check1", status, title: "SECRET @everyone", detail: { params: { token: "SECRET" } } } as Finding);
const note = (status = "pending"): Note => ({ id: "n1", trace_id: "trace1", finding_id: "f1", kind: "halt", status, text: "SECRET @everyone" } as Note);
function dispatcher(url: string, format: "json" | "slack" | "discord" = "json", options = {}) {
  const bus = new Bus(); const config = [{ url, events: ["halt", "finding"], format }];
  const d = new WebhookDispatcher(bus, () => config, { retryMs: 5, timeoutMs: 100, ...options });
  cleanup.push(() => d.close()); return { d, bus, config };
}
describe("outgoing webhooks", () => {
  it.each(["file:///tmp/a", "ftp://example.test/a", "https://u:p@example.test/", "https://example.test/#x"])("rejects unsafe URL without echo: %s", (url) => {
    expect(() => parseWebhooks([{ url, events: ["halt"] }])).toThrow("Invalid webhooks");
  });
  it("validates shape, bounds, duplicate destinations and event values", () => {
    for (const value of [{}, "secret", Array(17).fill({}), [{ url: "http://localhost", events: ["wrong"] }], [{ url: "http://localhost", events: ["halt", "halt"] }], [{ url: "http://localhost", events: ["halt"], format: "other" }], [{ url: "http://localhost", events: [], extra: true }]]) expect(() => parseWebhooks(value)).toThrow();
    for (const format of [["slack"], {}, null, 1]) expect(() => parseWebhooks([{ url: "http://localhost", events: ["halt"], format }])).toThrow();
    const a = { url: "http://localhost", events: ["halt"] };
    expect(() => parseWebhooks([a, a])).toThrow();
    expect(maskedWebhookUrl("https://hooks.example/TOKEN?q=QUERY")).toBe("https://hooks.example/[redacted]");
    expect(parseWebhooks(undefined)).toEqual([]);
  });
  it.each(["json", "slack", "discord"] as const)("sends private %s payloads and filters duplicate updates", async (format) => {
    const r = await receiver(); const { d, bus } = dispatcher(r.url, format);
    bus.emit("finding", finding()); bus.emit("finding", finding()); bus.emit("finding", finding("f1", "active"));
    bus.emit("note", note()); bus.emit("note", note()); bus.emit("note", note("delivered"));
    await vi.waitFor(() => expect(d.stats.sent).toBe(3));
    expect(r.bodies.join("")).not.toMatch(/SECRET|everyone|TOKEN|QUERY/);
    const payloads = r.bodies.map((b) => JSON.parse(b));
    if (format === "json") expect(payloads.map((p) => p.state).sort()).toEqual(["delivered", "queued", "raised"]);
    if (format === "slack") expect(payloads.every((p) => p.mrkdwn === false)).toBe(true);
    if (format === "discord") expect(payloads.every((p) => p.allowed_mentions.parse.length === 0)).toBe(true);
  });
  it("explicitly allowlists formatter input and blocks mentions in identifiers", () => {
    const p = webhookPayload({ event: "finding", state: "raised", trace_id: "@everyone", title: "SECRET" } as never, "json");
    expect(JSON.stringify(p)).not.toMatch(/SECRET|everyone|title/);
  });
  it("does nothing when omitted or empty and ignores non-selected events/states", async () => {
    const r = await receiver(); const bus = new Bus(); const d = new WebhookDispatcher(bus, () => []); cleanup.push(() => d.close());
    bus.emit("finding", finding()); expect(d.stats.accepted).toBe(0);
    const x = dispatcher(r.url); x.config[0].events = ["finding"]; x.d.reconcile();
    x.bus.emit("note", note()); x.bus.emit("finding", finding("f", "resolved"));
    expect(x.d.stats.accepted).toBe(0);
  });
  it("retries 429/5xx but stops permanent failures and redirects", async () => {
    let count = 0; const r = await receiver((_q, res) => { res.statusCode = ++count === 1 ? 429 : count === 2 ? 503 : 200; res.end("PRIVATE_RESPONSE"); });
    const x = dispatcher(r.url); x.bus.emit("finding", finding());
    await vi.waitFor(() => expect(x.d.stats.sent).toBe(1)); expect(count).toBe(3); expect(x.d.stats.retried).toBe(2);
    const target = await receiver(); const redirect = await receiver((_q, res) => { res.writeHead(302, { location: target.url }); res.end(); });
    const y = dispatcher(redirect.url); y.bus.emit("finding", finding());
    await vi.waitFor(() => expect(y.d.stats.failed).toBe(1)); expect(target.bodies).toHaveLength(0); expect(y.d.stats.retried).toBe(0);
    const bad = await receiver((_q, res) => { res.statusCode = 400; res.end(); });
    const z = dispatcher(bad.url); z.bus.emit("finding", finding()); await vi.waitFor(() => expect(z.d.stats.failed).toBe(1)); expect(bad.bodies).toHaveLength(1);
  });
  it("bounds retries after network errors and timeout", async () => {
    const r = await receiver(() => {}); const x = dispatcher(r.url, "json", { timeoutMs: 15 });
    x.bus.emit("finding", finding()); await vi.waitFor(() => expect(x.d.stats.failed).toBe(1));
    expect(x.d.stats.retried).toBe(2); expect(r.bodies.length).toBeLessThanOrEqual(3);
    const y = dispatcher("http://127.0.0.1:1/"); y.bus.emit("finding", finding());
    await vi.waitFor(() => expect(y.d.stats.failed).toBe(1)); expect(y.d.stats.retried).toBe(2);
  });
  it("bounds queue/concurrency and cancels all old work on reconfiguration/close", async () => {
    const r = await receiver(() => {}); const x = dispatcher(r.url, "json", { capacity: 2, concurrency: 1, timeoutMs: 5000 });
    for (let i = 0; i < 5; i++) x.bus.emit("finding", finding("f" + i));
    expect(x.d.pending).toBe(2); expect(x.d.stats.dropped).toBe(3);
    await vi.waitFor(() => expect(r.bodies).toHaveLength(1)); expect(x.d.inFlight).toBe(1);
    x.config.splice(0); x.d.reconcile();
    await vi.waitFor(() => expect(x.d.inFlight).toBe(0)); expect(x.d.pending).toBe(0);
    const accepted = x.d.stats.accepted; x.bus.emit("finding", finding("after")); expect(x.d.stats.accepted).toBe(accepted);
    x.d.close();
  });
  it("bounds dedupe history and allows notifications after oldest identity eviction", () => {
    const x = dispatcher("http://127.0.0.1:1/", "json", { dedupeSize: 2 });
    for (const id of ["one", "two", "three", "one"]) x.bus.emit("finding", finding(id));
    expect(x.d.stats.accepted).toBe(4);
    x.d.close(); x.bus.emit("settings", {}); x.bus.emit("finding", finding("closed"));
    expect(x.d.stats.accepted).toBe(4);
  });
  it("cancels retry backoff when disabled", async () => {
    const r = await receiver((_q, res) => { res.statusCode = 503; res.end(); });
    const x = dispatcher(r.url, "json", { retryMs: 250 });
    x.bus.emit("finding", finding());
    await vi.waitFor(() => expect(x.d.stats.retried).toBe(1));
    x.config.splice(0); x.bus.emit("settings", {});
    await vi.waitFor(() => expect(x.d.inFlight).toBe(0));
    await new Promise((r) => setTimeout(r, 25)); expect(r.bodies).toHaveLength(1);
  });
  it("cancels pending expired halts and does not deliver replaced notes", async () => {
    const r = await receiver(); const x = dispatcher(r.url);
    x.bus.emit("note", note()); x.bus.emit("note", note("expired"));
    x.bus.emit("note", { ...note(), kind: "llm" }); await new Promise((r) => setTimeout(r, 20));
    expect(x.d.pending).toBe(0); expect(r.bodies).toHaveLength(0); expect(x.d.stats.cancelled).toBe(1);
  });
});
