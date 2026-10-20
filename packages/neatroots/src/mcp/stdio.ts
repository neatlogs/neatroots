import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setQuiet } from "../util/log.js";

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts `neatroots start` in the background when no neatroots is running on the port. */
export async function ensureServer(port: number): Promise<void> {
  if (await healthy(port)) return;
  const cli = fileURLToPath(new URL(import.meta.url));
  const entry = process.argv[1] ?? cli;
  const child = spawn(process.execPath, [...process.execArgv, entry, "start", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await healthy(port)) return;
  }
  throw new Error(`neatroots did not start on port ${port}`);
}

/**
 * `neatroots mcp`: a stdio MCP server for coding agents. It relays JSON-RPC to the running
 * neatroots app's streamable HTTP endpoint, starting the app if needed, so every client sees
 * the same runs, findings and models.
 */
export async function runStdioBridge(port: number): Promise<void> {
  setQuiet(true);
  await ensureServer(port);
  const http = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  const stdio = new StdioServerTransport();
  stdio.onmessage = (m) => {
    http.send(m).catch((err) => {
      const id = (m as { id?: string | number }).id;
      if (id !== undefined) void stdio.send({ jsonrpc: "2.0", id, error: { code: -32000, message: `neatroots is not reachable: ${(err as Error).message}` } });
    });
  };
  http.onmessage = (m) => void stdio.send(m);
  http.onerror = () => undefined;
  stdio.onclose = () => {
    void http.close();
    process.exit(0);
  };
  await http.start();
  await stdio.start();
}
