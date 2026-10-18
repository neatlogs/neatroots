import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AmbientController } from "../src/ambient/controller.js";
import { ChromaOutput } from "../src/ambient/chroma.js";
import { normalizeAmbient } from "../src/ambient/config.js";
import { createApp } from "../src/server/app.js";
import { makeRoots, batch, hex, span } from "./helpers.js";
import type { AmbientConfig } from "../src/ambient/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) { for (let i = 0; i < 200; i++) { if (test()) return; await pause(5); } throw new Error("Condition not reached"); }
const config = (chroma = true, devices: NonNullable<AmbientConfig["outputs"]["chroma"]>["devices"] = ["chromalink"]): AmbientConfig => ({ enabled: true, outputs: { log: { enabled: true }, chroma: { enabled: chroma, animation: false, devices } } });
async function fixture(delay = false) {
  const tb = await makeRoots({ noEngine: true }); cleanups.push(tb.close);
  const requests: Array<{ method: string; path: string; body: string }> = [];
  let origin = "", first = true;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    requests.push({ method: req.method!, path: req.url!, body });
    const send = () => res.end(JSON.stringify(req.method === "POST" ? { sessionid: 1, uri: `${origin}/chromasdk` } : req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 }));
    if (delay && first && req.method === "POST") { first = false; setTimeout(send, 35); } else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const write = vi.fn();
  const outputs: ChromaOutput[] = [];
  const ambient = new AmbientController(tb.roots.store, tb.roots.bus, () => "unknown", { setState: write }, options => {
    const output = new ChromaOutput({ ...options, baseUrl: `${origin}/razer/chromasdk`, timeoutMs: 100, heartbeatMs: 20 }); outputs.push(output); return output;
  });
  cleanups.push(() => ambient.close());
  return { tb, ambient, write, requests, outputs, origin };
}

it("subscribes for Chroma independently, applies the global kill and strips labels", async () => {
  const { tb, ambient, requests, write } = await fixture();
  ambient.configure({ ...config(), enabled: false }); await ambient.flush(); expect(requests).toHaveLength(0);
  ambient.configure({ ...config(), outputs: { ...config().outputs, log: { enabled: false } } });
  await until(() => ambient.status().chroma.phase === "ready");
  const id = hex(16); const sp = span({ traceId: id, name: "PRIVATE_PROMPT", kind: "workflow" }); sp.endTimeUnixNano = "0";
  tb.roots.ingest([batch([sp], "PRIVATE_PROJECT")]);
  expect(ambient.status()).toMatchObject({ state: "live", project: "PRIVATE_PROJECT", subscribed: true });
  expect(write).not.toHaveBeenCalled(); expect(JSON.stringify(requests)).not.toContain("PRIVATE");
  ambient.configure({ ...config(), enabled: false }); await ambient.flush();
  expect(ambient.status()).toMatchObject({ state: "inactive", subscribed: false, chroma: { phase: "inactive" } });
  expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
  const count = requests.length; await pause(35); expect(requests).toHaveLength(count);
});

it("serializes delayed registration teardown and coalesces reconfiguration to the newest devices", async () => {
  const { ambient, requests } = await fixture(true);
  ambient.configure(config()); await until(() => requests.length === 1);
  ambient.configure(config(true, ["keyboard"]));
  ambient.configure(config(true, ["mouse"]));
  await ambient.flush(); await until(() => ambient.status().chroma.phase === "ready");
  const registrations = requests.filter(r => r.method === "POST");
  expect(registrations).toHaveLength(2);
  expect(JSON.parse(registrations[1].body).device_supported).toEqual(["mouse"]);
  expect(requests.findIndex(r => r.method === "DELETE")).toBeLessThan(requests.indexOf(registrations[1]));
});

it("isolates a failed logger and retries a failed Chroma only on an explicit request", async () => {
  const { ambient, write, requests, outputs, origin } = await fixture();
  write.mockImplementation(() => { throw new Error("PRIVATE_ERROR"); });
  ambient.configure(config()); await until(() => ambient.status().chroma.phase === "ready");
  expect(ambient.status().output_error).toBe(true);
  await outputs[0].close();
  // Force a known unavailable factory for the first attempt, without touching a device endpoint.
  await ambient.close();
  const tb = await makeRoots({ noEngine: true }); cleanups.push(tb.close);
  let attempts = 0;
  const retry = new AmbientController(tb.roots.store, tb.roots.bus, () => "unknown", { setState: vi.fn() }, options => {
    attempts++;
    if (attempts === 1) throw new Error("PRIVATE_FAILURE");
    return new ChromaOutput({ ...options, baseUrl: `${origin}/razer/chromasdk`, timeoutMs: 100 });
  }); cleanups.push(() => retry.close());
  retry.configure(config()); await retry.flush(); expect(retry.status().chroma.phase).toBe("unavailable");
  retry.configure(config()); await pause(30); expect(attempts).toBe(1);
  retry.retryChroma(); await retry.flush(); expect(attempts).toBe(2);
  await until(() => retry.status().chroma.phase === "ready");
  expect(JSON.stringify(requests)).not.toContain("PRIVATE");
});

it("validates all ambient settings before mutation and never accepts transport test options", async () => {
  const tb = await makeRoots({ noEngine: true }); cleanups.push(tb.close);
  const app = createApp(tb.roots);
  const post = (body: unknown) => app.request("/api/settings", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
  const before = JSON.stringify(tb.roots.config.ambient);
  for (const body of [
    { ambient_enabled: true, ambient_chroma_animation: "true" },
    { ambient_enabled: true, ambient_chroma_devices: ["../heartbeat"] },
    { ambient_enabled: true, ambient_chroma_devices: [] },
    { ambient_enabled: true, ambient_chroma_base_url: "http://example.com" },
    { ambient_enabled: true, ambient_chroma_frameMs: 1 },
    { ambient_chroma_retry: true },
  ]) { expect((await post(body)).status).toBe(400); expect(JSON.stringify(tb.roots.config.ambient)).toBe(before); }
  expect((await post({ ambient_chroma_enabled: true, ambient_chroma_animation: true, ambient_chroma_devices: ["mouse", "keyboard"] })).status).toBe(200);
  expect(tb.roots.ambient.status()).toMatchObject({ enabled: false, chroma: { configured: true, animation: true, devices: ["keyboard", "mouse"], phase: "inactive" } });
});

it("keeps malformed persisted Chroma off and never treats root end as trustworthy success", async () => {
  expect(normalizeAmbient({ enabled: true, outputs: { log: { enabled: false }, chroma: { enabled: true, animation: false, devices: ["unsafe"] as never } } }).outputs.chroma?.enabled).toBe(false);
  const tb = await makeRoots({ noEngine: true }); cleanups.push(tb.close);
  tb.roots.config.ambient = config(false); tb.roots.saveConfig();
  tb.roots.ingest([batch([span({ traceId: hex(16), name: "finished", kind: "workflow" })])]);
  expect(tb.roots.ambient.status().state).toBe("incomplete");
});
