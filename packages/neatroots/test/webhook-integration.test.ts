import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { Roots } from "../src/core.js";
import { createApp } from "../src/server/app.js";
import { batch, toolSpan } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function setup(enabled = true) {
  const bodies: string[] = [];
  let release: (() => void) | undefined;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part; bodies.push(body);
    release = () => res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/PATH_SECRET?q=QUERY_SECRET";
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-webhook-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig();
  if (enabled) config.webhooks = [{ url, events: ["halt", "finding"], format: "json" }];
  config.projects.demo = { steering: "advisory" };
  const roots = new Roots({ home, config, noEngine: true }); cleanups.push(() => roots.close());
  const trace = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; const parent = "0123456789abcdef";
  const ingest = () => roots.ingest([batch([toolSpan(trace, parent, "tool", "PRIVATE_INPUT", "PRIVATE_OUTPUT")])]);
  ingest();
  config.projects[roots.store.getRun(trace)!.project!] = { steering: "advisory" };
  const finding = roots.store.insertFinding({ trace_id: trace, check_id: "private-check", check_kind: "rule", title: "PRIVATE_TITLE", status: "raised", probability: null, evidence_span_ids: [], detail: { params: { key: "PRIVATE_PARAM" } }, model: null, triage_score: null, explanation_id: null });
  return { bodies, roots, url, home, finding, trace, ingest, release: () => release?.() };
}
describe("webhook Roots integration", () => {
  it("dispatches asynchronously from real finding and steering events without waiting for HTTP", async () => {
    const x = await setup();
    const start = performance.now(); x.roots.bus.emit("finding", x.finding);
    const n = x.roots.steering.push({ traceId: x.trace, findingId: x.finding.id, kind: "halt", text: "PRIVATE_NOTE" });
    expect(n).toBeDefined(); expect(x.roots.steering.claim(x.trace)?.id).toBe(n!.id);
    x.ingest(); expect(performance.now() - start).toBeLessThan(500);
    await vi.waitFor(() => expect(x.bodies.length).toBeGreaterThan(0), { timeout: 1000 });
    expect(x.bodies.join("")).not.toMatch(/PRIVATE_|PATH_SECRET|QUERY_SECRET/);
    expect(x.roots.webhooks.inFlight).toBeGreaterThan(0);
  });
  it("omitted configuration never delivers", async () => {
    const x = await setup(false); x.roots.bus.emit("finding", x.finding);
    await new Promise((r) => setTimeout(r, 20)); expect(x.bodies).toEqual([]);
  });
  it("keeps destination secrets out of status/settings and applies disable at runtime", async () => {
    const x = await setup(); const app = createApp(x.roots);
    const status = await (await app.request("/api/status", { headers: { host: "localhost" } })).text();
    expect(status).not.toMatch(/PATH_SECRET|QUERY_SECRET/);
    const response = await app.request("/api/settings", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ webhooks: [] }) });
    expect(response.status).toBe(200); expect(await response.text()).not.toMatch(/PATH_SECRET|QUERY_SECRET/);
    x.roots.bus.emit("finding", x.finding); expect(x.roots.webhooks.stats.accepted).toBe(0);
    const invalid = await app.request("/api/settings", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ webhooks: [{ url: "file:///PRIVATE_SECRET", events: ["finding"] }] }) });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("PRIVATE_SECRET"); expect(x.roots.config.webhooks).toEqual([]);
  });
  it("rejects non-string formats without persisting or reconfiguring", async () => {
    const x = await setup(); const app = createApp(x.roots);
    const save = vi.spyOn(x.roots, "saveConfig"); const reconcile = vi.spyOn(x.roots.webhooks, "reconcile");
    for (const format of [["slack"], {}, null, 1]) {
      const res = await app.request("/api/settings", { method: "POST", headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ webhooks: [{ url: x.url, events: ["halt"], format }] }) });
      expect(res.status).toBe(400);
    }
    expect(save).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    expect(x.roots.config.webhooks?.[0].format).toBe("json");
  });
  it("keeps the prior destination when persistence fails without leaking secrets", async () => {
    const x = await setup(); const app = createApp(x.roots); const rejected: string[] = [];
    const server = http.createServer(async (req, res) => { let body = ""; for await (const p of req) body += p; rejected.push(body); res.end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/REFUSED_SECRET";
    x.roots.saveConfig();
    const previousFile = fs.readFileSync(path.join(x.home, "config.yaml"), "utf8");
    const write = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]) === path.join(x.home, "config.yaml")) throw new Error(url);
      return Reflect.apply(write, fs, args);
    });
    try {
      const res = await app.request("/api/settings", { method: "POST", headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ webhooks: [{ url, events: ["finding"], format: "json" }] }) });
      expect(res.status).toBe(500); expect(await res.text()).not.toContain("REFUSED_SECRET");
      expect(x.roots.config.webhooks?.[0].url).toBe(x.url);
      expect(fs.readFileSync(path.join(x.home, "config.yaml"), "utf8")).toBe(previousFile);
      x.roots.bus.emit("finding", x.finding);
      await vi.waitFor(() => expect(x.bodies).toHaveLength(1));
      expect(rejected).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it("persists private config and disables malformed hand-edited webhooks safely", async () => {
    const x = await setup(); vi.stubEnv("NEATROOTS_HOME", x.home);
    saveConfig(x.roots.config, path.join(x.home, "config.yaml"));
    expect(loadConfig().webhooks).toEqual(x.roots.config.webhooks);
    if (process.platform !== "win32") expect(fs.statSync(path.join(x.home, "config.yaml")).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(x.home, "config.yaml"), "webhooks: [bad]");
    expect(loadConfig().webhooks).toEqual([]);
  });
});
