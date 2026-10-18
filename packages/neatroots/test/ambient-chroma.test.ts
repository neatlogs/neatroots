import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ChromaOutput } from "../src/ambient/chroma.js";
import type { AmbientState } from "../src/ambient/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(handler?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ method: req.method!, path: req.url!, body });
    if (handler?.(req, res)) return;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? { sessionid: 1, uri: `${origin}/chromasdk` }
      : req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const output = new ChromaOutput({ baseUrl: `${origin}/razer/chromasdk`, timeoutMs: 100, heartbeatMs: 20, maxResponseBytes: 1024 });
  cleanup.push(() => output.close());
  return { output, requests, origin };
}
function state(output: ChromaOutput, value: AmbientState) {
  output.setState({ state: value, trace_id: "SECRET_TRACE", project: "SECRET_PROJECT", workflow: "SECRET_WORKFLOW", active_runs: 9 });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("static Chroma owner", () => {
  it("defaults off, sends only static colors, coalesces, heartbeats and tears down", async () => {
    const { output, requests } = await fixture();
    state(output, "live"); await output.flush(); expect(requests).toHaveLength(0);
    output.setEnabled(true); await output.flush();
    expect(output.status().phase).toBe("ready");
    const count = requests.filter(r => r.path.endsWith("chromalink")).length;
    state(output, "live"); await output.flush(); expect(requests.filter(r => r.path.endsWith("chromalink"))).toHaveLength(count);
    const colors = new Set<number>();
    for (const value of ["live", "checking", "loop", "error", "interrupted", "attention", "incomplete", "success"] as const) {
      state(output, value); await output.flush();
      colors.add(JSON.parse(requests.findLast(r => r.path.endsWith("chromalink"))!.body).param.color);
    }
    expect(colors.size).toBe(8);
    for (let i = 0; i < 100; i++) state(output, i % 2 ? "success" : "loop");
    await output.flush(); expect(output.status().state).toBe("success");
    await pause(35); await output.flush(); expect(requests.some(r => r.path.endsWith("heartbeat"))).toBe(true);
    state(output, "idle"); await output.flush(); expect(JSON.parse(requests.findLast(r => r.path.endsWith("chromalink"))!.body).effect).toBe("CHROMA_NONE");
    await output.close(); await output.close();
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
    const closedCount = requests.length; await pause(40); expect(requests).toHaveLength(closedCount);
    expect(JSON.stringify(requests)).not.toContain("SECRET");
  });
  it("bounds rapid changes to one in-flight request and services heartbeat", async () => {
    let active = 0, maximum = 0;
    const { output, requests } = await fixture((req, res) => {
      if (req.method === "POST") return false;
      active++; maximum = Math.max(maximum, active);
      setTimeout(() => { active--; res.end(JSON.stringify(req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 })); }, 15);
      return true;
    });
    output.setEnabled(true);
    const updates = setInterval(() => { state(output, "loop"); state(output, "success"); }, 2);
    await pause(80); clearInterval(updates); await output.flush();
    expect(maximum).toBe(1);
    expect(requests.length).toBeLessThan(15);
    expect(requests.some(r => r.path.endsWith("heartbeat"))).toBe(true);
    output.setEnabled(false); await output.flush();
    expect(output.status().phase).toBe("inactive");
  });
  it("accepts the documented separate loopback session port", async () => {
    const session = await fixture();
    const registration = await fixture((req, res) => {
      res.end(JSON.stringify({ sessionid: 2, uri: `${session.origin}/chromasdk` })); return true;
    });
    registration.output.setEnabled(true); await registration.output.flush();
    expect(registration.output.status().phase).toBe("ready");
    expect(registration.requests).toHaveLength(1);
    expect(session.requests[0].path).toBe("/chromasdk/chromalink");
    await registration.output.close();
  });
  it("preserves explicit retry issued during failed-effect cleanup", async () => {
    let fail = true;
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const { output, requests } = await fixture((req, res) => {
      if (req.method === "POST") return false;
      if (fail && req.url?.endsWith("chromalink")) {
        fail = false; res.end('{"result":5}'); return true;
      }
      if (req.url?.endsWith("chromalink")) {
        cleanupStarted(); setTimeout(() => res.end('{"result":0}'), 20); return true;
      }
      return false;
    });
    state(output, "live"); output.setEnabled(true);
    await started; output.setEnabled(true); await output.flush();
    expect(output.status().phase).toBe("ready");
    expect(requests.filter(r => r.method === "POST")).toHaveLength(2);
  });
  it("preserves new enable after disabling a delayed failed registration", async () => {
    let first = true;
    const { output, requests } = await fixture((req, res) => {
      if (req.method === "POST" && first) {
        first = false; setTimeout(() => { res.statusCode = 500; res.end("{}"); }, 25); return true;
      }
      return false;
    });
    output.setEnabled(true); await pause(10); output.setEnabled(false); output.setEnabled(true);
    await output.flush();
    expect(output.status().phase).toBe("ready");
    expect(requests.filter(r => r.method === "POST")).toHaveLength(2);
  });
  it("replaces the session after disable/re-enable during heartbeat", async () => {
    let heartbeatStarted!: () => void;
    const started = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    const { output, requests } = await fixture((req, res) => {
      if (!req.url?.endsWith("heartbeat")) return false;
      heartbeatStarted(); setTimeout(() => res.end('{"tick":1}'), 25); return true;
    });
    output.setEnabled(true); await started;
    output.setEnabled(false); output.setEnabled(true); await output.flush();
    expect(output.status().phase).toBe("ready");
    expect(requests.filter(r => r.method === "POST")).toHaveLength(2);
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
  });
  it("does not rearm a heartbeat completed after disable", async () => {
    let heartbeatStarted!: () => void;
    const started = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    const { output, requests } = await fixture((req, res) => {
      if (!req.url?.endsWith("heartbeat")) return false;
      heartbeatStarted(); setTimeout(() => res.end('{"tick":1}'), 25); return true;
    });
    output.setEnabled(true); await started; output.setEnabled(false); await output.flush();
    expect((output as unknown as { timer: unknown }).timer).toBeUndefined();
    const count = requests.length; await pause(50); expect(requests).toHaveLength(count);
    expect(output.status().phase).toBe("inactive");
  });
  it("cleans up registration completed after disable without applying a color", async () => {
    const { output, requests } = await fixture((req, res) => {
      if (req.method !== "POST") return false;
      const host = req.headers.host;
      setTimeout(() => res.end(JSON.stringify({ sessionid: 1, uri: `http://${host}/chromasdk` })), 30); return true;
    });
    output.setEnabled(true); await pause(10); output.setEnabled(false); await output.flush();
    expect(output.status().phase).toBe("inactive");
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
    expect(requests.some(r => r.body.includes("CHROMA_STATIC"))).toBe(false);
  });
  it.each(["https://127.0.0.1/chromasdk", "http://evil.example/chromasdk", "http://user@127.0.0.1/chromasdk", "http://127.0.0.1/chromasdk?x=1", "http://127.0.0.1/unexpected", "http://127.0.0.1/chromasdk#x"])("rejects session URI %s", async uri => {
    const { output, requests } = await fixture((req, res) => { res.end(JSON.stringify({ sessionid: 1, uri })); return true; });
    output.setEnabled(true); await output.flush(); expect(output.status().phase).toBe("unavailable"); expect(requests).toHaveLength(1);
  });
  it.each(["redirect", "oversized", "timeout", "http", "invalid", "sdk"])("disables on %s without retries", async mode => {
    const { output, requests } = await fixture((req, res) => {
      if (mode === "sdk" && req.method === "POST") return false;
      if (mode === "redirect") { res.writeHead(302, { Location: "http://evil.example/" }); res.end(); }
      else if (mode === "oversized") res.end("x".repeat(2000));
      else if (mode === "timeout") { /* request times out */ }
      else if (mode === "http") { res.statusCode = 500; res.end("{}"); }
      else res.end(mode === "sdk" ? '{"result":5}' : "not json");
      return true;
    });
    output.setEnabled(true); await output.flush(); expect(output.status().phase).toBe("unavailable");
    const count = requests.length; await pause(40); expect(requests).toHaveLength(count);
  });
  it("handles unreachable loopback and rejects remote test endpoints", async () => {
    const { origin, output } = await fixture(); await output.close();
    const unavailable = new ChromaOutput({ baseUrl: "http://127.0.0.1:1/razer/chromasdk", timeoutMs: 30 });
    unavailable.setEnabled(true); await unavailable.flush(); expect(unavailable.status().phase).toBe("unavailable"); await unavailable.close();
    expect(() => new ChromaOutput({ baseUrl: "http://example.com/razer/chromasdk" })).toThrow();
    expect(origin).toContain("127.0.0.1");
  });
});
