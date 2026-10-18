import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createShutdown } from "../src/cli/shutdown.js";
import { freePort, makeRoots } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, diagnostic: () => string = () => "") {
  for (let i = 0; i < 1200; i++) { if (check()) return; await pause(5); }
  throw new Error(`Condition not reached: ${diagnostic()}`);
}

it("returns one Roots.close promise while preserving immediate synchronous resource cleanup", async () => {
  const tb = await makeRoots({ noEngine: true }); cleanups.push(tb.close);
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const close = vi.spyOn(tb.roots.ambient, "close").mockReturnValue(closed);
  const first = tb.roots.close();
  expect(tb.roots.close()).toBe(first); expect(close).toHaveBeenCalledTimes(1);
  expect(tb.roots.store.db.open).toBe(false);
  finish(); await first;
});

it("bounds a hung cleanup and shares one stop operation across repeated signals", async () => {
  vi.useFakeTimers();
  const close = vi.fn(() => new Promise<void>(() => {}));
  const exit = vi.fn(), log = vi.fn();
  const stop = createShutdown(close, exit, log, 50);
  const first = stop(); expect(stop()).toBe(first);
  await vi.advanceTimersByTimeAsync(49); expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await first;
  expect(close).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(log).toHaveBeenCalledWith("shutdown cleanup did not complete");
});

it("turns a rejected cleanup into one failure exit without leaking its error", async () => {
  const exit = vi.fn(), log = vi.fn();
  const stop = createShutdown(() => Promise.reject(new Error("PRIVATE")), exit, log);
  await Promise.all([stop(), stop()]);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});

it.skipIf(process.platform === "win32").each([false, true])("actual CLI waits for fake Chroma teardown (timeout=%s), even on repeated SIGTERM", async timeout => {
  let initialClear = false;
  let stopping = false, clearStarted = false, clearFinished = false, deleteFinished = false;
  let deletes = 0, clears = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === "POST") { res.end(JSON.stringify({ sessionid: 1, uri: `http://localhost:${port}/chromasdk` })); return; }
    if (req.method === "DELETE") {
      deletes++;
      setTimeout(() => { deleteFinished = true; res.end(JSON.stringify({ result: 0 })); }, 80);
      return;
    }
    if (stopping && req.url === "/chromasdk/chromalink") {
      clearStarted = true; clears++;
      if (!timeout) setTimeout(() => { clearFinished = true; res.end(JSON.stringify({ result: 0 })); }, 80);
      return;
    }
    if (req.url === "/chromasdk/chromalink") initialClear = true;
    res.end(JSON.stringify(req.url?.endsWith("heartbeat") ? { tick: 1 } : { result: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-cli-shutdown-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "config.yaml"), `port: ${await freePort()}
grpcPort: 0
ambient:
  enabled: true
  outputs:
    chroma:
      enabled: true
      animation: false
      devices: [chromalink]
`);
  // Test-process-only transport shim. Production still has no endpoint option in config/API.
  const shim = path.join(home, "fake-chroma.mjs");
  fs.writeFileSync(shim, `const original = globalThis.fetch; globalThis.fetch = (input, options) => {
    const url = String(input);
    if (url === 'http://localhost:54235/razer/chromasdk') return original('http://127.0.0.1:${port}/razer/chromasdk', options);
    if (url.startsWith('http://localhost:${port}/chromasdk')) return original(url, options);
    throw new Error('Unexpected transport in isolated CLI test');
  };`);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", shim, cli, "start", "--no-engine", "--no-laya", "--grpc-port", "0"], {
    env: { ...process.env, NEATROOTS_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", exited = false;
  child.stdout?.on("data", data => { output += String(data); });
  child.stderr?.on("data", data => { output += String(data); });
  const exit = new Promise<number | null>(resolve => child.once("exit", code => { exited = true; resolve(code); }));
  cleanups.push(async () => { if (!exited) { child.kill("SIGKILL"); await exit; } });
  await until(() => output.includes("app: http://localhost:") && output.includes("machine:") && initialClear, () => output);
  stopping = true;
  const started = Date.now(); child.kill("SIGTERM");
  await until(() => clearStarted || exited, () => output);
  expect(exited).toBe(false);
  child.kill("SIGTERM");
  expect(await exit).toBe(0);
  expect(deletes).toBe(1); expect(clears).toBe(1); expect(deleteFinished).toBe(true);
  if (timeout) expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  else expect(clearFinished).toBe(true);
  expect(output.match(/stopping/g)).toHaveLength(1);
}, 20_000);
