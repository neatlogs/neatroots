import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ChromaOutput, type ChromaOptions } from "../src/ambient/chroma.js";
import { CHROMA_DEVICES, chromaDevices, chromaFrame, type ChromaDevice } from "../src/ambient/chroma-frames.js";
import type { AmbientState } from "../src/ambient/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await pause(5); }
  throw new Error("Condition not reached");
}
function state(output: ChromaOutput, value: AmbientState) {
  output.setState({ state: value, trace_id: "PRIVATE_TRACE", project: "PRIVATE_PROJECT", workflow: "PRIVATE_WORKFLOW", active_runs: 4 });
}
type Request = { method: string; path: string; body: string; at: number };
async function fixture(options: ChromaOptions = {}, handler?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const requests: Request[] = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ method: req.method!, path: req.url!, body, at: performance.now() });
    if (handler?.(req, res)) return;
    res.end(JSON.stringify(req.method === "POST" ? { sessionid: 1, uri: `${origin}/chromasdk` }
      : req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const output = new ChromaOutput({ baseUrl: `${origin}/razer/chromasdk`, timeoutMs: 300, heartbeatMs: 50, frameMs: 10, ...options });
  cleanup.push(() => output.close());
  return { output, requests };
}
const effects = (requests: Request[]) => requests.filter(r => CHROMA_DEVICES.some(d => r.path === `/chromasdk/${d}`));
const latest = (requests: Request[]) => JSON.parse(effects(requests).at(-1)!.body);

describe("pure Chroma frames", () => {
  it("retains every default static color and clear state", () => {
    for (const name of ["live", "checking", "loop", "error", "interrupted", "attention", "incomplete", "success"] as const) {
      expect(chromaFrame(name, 0)).toEqual(chromaFrame(name, 99999));
      expect(chromaFrame(name, 0).moving).toBe(false);
    }
    expect(chromaFrame("idle", 0, true).body).toEqual({ effect: "CHROMA_NONE" });
    expect(chromaFrame("inactive", 0, true).body).toEqual({ effect: "CHROMA_NONE" });
  });
  it("breathes slowly, pulses amber and holds error/interrupted/incomplete steady", () => {
    expect(chromaFrame("live", 0, true)).toEqual(chromaFrame("live", 4000, true));
    expect(chromaFrame("live", 2000, true).body).toEqual(chromaFrame("live", 0).body);
    expect(chromaFrame("loop", 0, true)).toEqual(chromaFrame("loop", 1000, true));
    expect(chromaFrame("loop", 500, true).body).toEqual(chromaFrame("loop", 0).body);
    for (const name of ["error", "interrupted", "incomplete"] as const) {
      expect(chromaFrame(name, 0, true)).toEqual(chromaFrame(name, 99999, true));
    }
    expect(chromaFrame("interrupted", 0).body).not.toEqual(chromaFrame("incomplete", 0).body);
  });
  it("holds upstream success green, fades once then clears", () => {
    expect(chromaFrame("success", 1200, true).body).toEqual(chromaFrame("success", 0).body);
    expect(chromaFrame("success", 2100, true).body).not.toEqual(chromaFrame("success", 0).body);
    expect(chromaFrame("success", 3000, true)).toEqual({ body: { effect: "CHROMA_NONE" }, moving: false });
    expect(chromaFrame("success", 99999, true)).toEqual(chromaFrame("success", 3000, true));
  });
  it("validates and copies a bounded canonical device allowlist", () => {
    expect(chromaDevices()).toEqual(["chromalink"]);
    expect(chromaDevices(["mouse", "keyboard", "mouse"])).toEqual(["keyboard", "mouse"]);
    expect(() => chromaDevices([])).toThrow();
    expect(() => chromaDevices(["../heartbeat" as ChromaDevice])).toThrow();
    expect(() => new ChromaOutput({ animation: "yes" as unknown as boolean })).toThrow();
    expect(() => new ChromaOutput({ frameMs: 0 })).toThrow();
  });
});

describe("animated multi-device HTTP owner", () => {
  it("opts into all six documented static/clear endpoints without sending telemetry", async () => {
    const { output, requests } = await fixture({ devices: CHROMA_DEVICES });
    state(output, "error"); await output.flush(); expect(requests).toHaveLength(0);
    output.setEnabled(true); await output.flush();
    expect(JSON.parse(requests[0].body).device_supported).toEqual(CHROMA_DEVICES);
    expect(effects(requests).map(r => r.path)).toEqual(CHROMA_DEVICES.map(d => `/chromasdk/${d}`));
    expect(effects(requests).every(r => r.body === JSON.stringify(chromaFrame("error", 0).body))).toBe(true);
    await output.close();
    expect(effects(requests).slice(-6).every(r => JSON.parse(r.body).effect === "CHROMA_NONE")).toBe(true);
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("PRIVATE");
  });
  it("does not restart repeated state but restarts a genuine transition", async () => {
    let now = 0;
    const { output, requests } = await fixture({ animation: true, now: () => now });
    state(output, "live"); output.setEnabled(true); await output.flush();
    expect(latest(requests)).toEqual(chromaFrame("live", 0, true).body);
    now = 2000; state(output, "live");
    await until(() => JSON.stringify(latest(requests)) === JSON.stringify(chromaFrame("live", 2000, true).body));
    state(output, "error"); await output.flush();
    now = 3000; state(output, "live"); await output.flush();
    expect(latest(requests)).toEqual(chromaFrame("live", 0, true).body);
    expect((output as unknown as { frameStarted: number }).frameStarted).toBe(3000);
  });
  it("finishes success fade and stops frame timers without inferring success", async () => {
    let now = 0;
    const { output, requests } = await fixture({ animation: true, now: () => now });
    state(output, "checking"); output.setEnabled(true); await output.flush();
    now = 10000; await pause(25); expect(latest(requests)).toEqual(chromaFrame("checking", 0).body);
    state(output, "success"); await output.flush();
    now = 13000;
    await until(() => latest(requests).effect === "CHROMA_NONE");
    const count = effects(requests).length;
    await pause(35); expect(effects(requests)).toHaveLength(count);
    expect((output as unknown as { frameTimer: unknown }).frameTimer).toBeUndefined();
  });
  it("serializes slow multi-device frames and interleaves priority heartbeat", async () => {
    let active = 0, maximum = 0;
    const { output, requests } = await fixture({ devices: CHROMA_DEVICES, animation: true, heartbeatMs: 20 }, (req, res) => {
      if (req.method === "POST") return false;
      active++; maximum = Math.max(maximum, active);
      setTimeout(() => { active--; res.end(JSON.stringify(req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 })); }, 15);
      return true;
    });
    state(output, "loop"); output.setEnabled(true);
    await until(() => effects(requests).length >= 12);
    output.setEnabled(false); await output.flush();
    expect(maximum).toBe(1);
    expect(effects(requests).slice(0, 6).map(r => r.path)).toEqual(CHROMA_DEVICES.map(d => `/chromasdk/${d}`));
    const heartbeats = requests.filter(r => r.path.endsWith("heartbeat"));
    expect(heartbeats.length).toBeGreaterThan(2);
    expect(requests.findIndex(r => r.path.endsWith("heartbeat"))).toBeLessThan(6);
    // Bound by one slow device plus event-loop allowance, not the complete six-device frame.
    expect(Math.max(...heartbeats.slice(1).map((r, i) => r.at - heartbeats[i].at))).toBeLessThan(120);
    const count = requests.length; await pause(30); expect(requests).toHaveLength(count);
  });
  it("cancels the remainder of a frame on disable and creates a fresh session on re-enable", async () => {
    let release!: () => void;
    let blocked = true;
    const { output, requests } = await fixture({ devices: ["keyboard", "mouse"], animation: true }, (req, res) => {
      if (blocked && req.url === "/chromasdk/keyboard") {
        blocked = false; release = () => res.end('{"result":0}'); return true;
      }
      return false;
    });
    state(output, "live"); output.setEnabled(true);
    await until(() => !!release); output.setEnabled(false); release(); await output.flush();
    expect(effects(requests).filter(r => JSON.parse(r.body).effect === "CHROMA_STATIC")).toHaveLength(1);
    expect((output as unknown as { frameTimer: unknown }).frameTimer).toBeUndefined();
    output.setEnabled(true); await output.flush();
    expect(requests.filter(r => r.method === "POST")).toHaveLength(2);
    expect(output.status().phase).toBe("ready");
    await output.close();
  });
  it("aborts an old frame on a changed state and never sends its remaining devices", async () => {
    let release!: () => void;
    let blocked = true;
    const { output, requests } = await fixture({ devices: ["keyboard", "mouse"], animation: true }, (req, res) => {
      if (blocked && req.url === "/chromasdk/keyboard") {
        blocked = false; release = () => res.end('{"result":0}'); return true;
      }
      return false;
    });
    state(output, "live"); output.setEnabled(true); await until(() => !!release);
    state(output, "error"); release(); await output.flush();
    const mouse = effects(requests).filter(r => r.path.endsWith("mouse"));
    expect(mouse).toHaveLength(1); expect(JSON.parse(mouse[0].body)).toEqual(chromaFrame("error", 0).body);
  });
});
