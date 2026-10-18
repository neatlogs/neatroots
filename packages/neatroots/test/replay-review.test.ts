import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { EXPLORE_TOOLS } from "../src/mcp/explore-tools.js";
import { TOOLS } from "../src/mcp/tools.js";
import { batch, hex, makeRoots, span, tmpHome, until } from "./helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

it.skipIf(process.platform === "win32")("second SIGINT exits the actual CLI while cancellation and active server work remain pending", async () => {
  let cancellations = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    if (req.url?.endsWith("/cancel")) { cancellations++; return; } // Deliberately no response.
    if (req.method === "POST") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "rb_signal", state: "running", times: 2 }));
    }
    // Status also stays pending: second interrupt must not wait for either request.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const home = tmpHome(); cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(home, "config.yaml"), `port: ${port}\n`);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", cli, "replay", "abc", "--times", "2"], {
    env: { ...process.env, NEATROOTS_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); } });
  let text = ""; child.stdout!.on("data", b => { text += b; }); child.stderr!.on("data", b => { text += b; });
  let exit: { code: number | null; signal: string | null } | undefined;
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  await until(() => text.includes("Batch rb_signal"));
  child.kill("SIGINT");
  await until(() => cancellations === 1);
  expect(exit).toBeUndefined();
  child.kill("SIGINT");
  await until(() => exit !== undefined, 2500);
  expect(exit).toEqual({ code: 130, signal: null });
  expect(cancellations).toBe(1);
  expect(text).toContain("active work");
  expect(text).toContain(`http://localhost:${port}/api/replay-batches/rb_signal`);
  // The CLI only detaches; this independent server still answers requests.
  expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
});

it.each(["replay", "rerun"])("%s batches disclose deleted-focus fallback and preserve batch notes", async name => {
  const t = await makeRoots({ noEngine: true }); cleanup.push(t.close);
  const trace = hex(16), missing = hex(16);
  t.roots.ingest([batch([span({ traceId: trace, name: "latest", kind: "workflow" })])]);
  const summary = { id: "rb_note", trace_id: trace, times: 2, state: "running", pending: 2, note: "Batch remains active; poll its status." };
  const start = vi.spyOn(t.roots.replayBatches, "start").mockReturnValue({ batch: summary, done: Promise.resolve(summary) } as never);
  const tool = (name === "replay" ? EXPLORE_TOOLS : TOOLS).find(tool => tool.name === name)!;
  t.roots.focus = { trace_id: missing, span_id: null, at: Date.now() };
  const result = await tool.run(t.roots, { times: 2 }) as typeof summary;
  expect(result).toMatchObject({ id: "rb_note", trace_id: trace, times: 2, pending: 2 });
  expect(result.note).toContain(missing.slice(0, 8));
  expect(result.note).toContain("using the latest run");
  expect(result.note).toContain(summary.note);
  expect(start.mock.calls[0][0]).toBe(trace);
  t.roots.focus = { trace_id: missing, span_id: null, at: Date.now() };
  const explicit = await tool.run(t.roots, { trace_id: trace, times: 2 });
  expect(explicit).toEqual(summary);
  expect(t.roots.focus?.trace_id).toBe(missing);
});
