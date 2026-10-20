import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seed } from "./seed";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../neatroots/dist/cli.js");
export const STATE = path.join(here, ".state.json");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up`);
}

function start(args: string[], env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const out = fs.openSync(log, "w");
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", out, out], detached: false });
  child.unref();
  return child;
}

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(cli)) throw new Error(`build first: ${cli} is missing (pnpm build)`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-e2e-"));
  const [port, mockPort, layaPort] = [await freePort(), await freePort(), await freePort()];
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    [
      `port: ${port}`,
      "grpcPort: 0",
      "llm:",
      `  baseUrl: http://127.0.0.1:${mockPort}/v1`,
      "  model: mock",
      "classifier:",
      "  backend: llm",
      // Laya on but not downloaded (nothing downloads without a yes), on a port of its own so a
      // Laya already running on this machine isn't picked up.
      "  laya:",
      "    enabled: true",
      `    port: ${layaPort}`,
      "",
    ].join("\n"),
  );
  // A home of its own; Claude Code points nowhere (so neatroots doesn't find one in /Applications
  // either) and Codex is a script that answers like `codex exec --json`. Cursor looks installed.
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    NEATROOTS_HOME: home,
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NEATROOTS_CLAUDE_BIN: path.join(home, "no-claude"),
    NEATROOTS_CODEX_BIN: path.join(here, "fixtures", "fake-codex"),
    NEATROOTS_DEBUG: "",
  };
  const mock = start(["mock-llm", "--port", String(mockPort)], env, path.join(home, "mock.log"));
  const server = start(["start", "--port", String(port), "--grpc-port", "0"], env, path.join(home, "server.log"));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`http://127.0.0.1:${mockPort}/v1/models`);
  await waitFor(`${url}/api/status`);
  const seeded = await seed(url);
  fs.writeFileSync(STATE, JSON.stringify({ url, home, pids: [server.pid, mock.pid], mockUrl: `http://127.0.0.1:${mockPort}/v1`, ...seeded }, null, 2));
  process.env.NEATROOTS_E2E_URL = url;
}
