import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freePort } from "./helpers.js";

// A chat's agent runs in its own process group and session, so closing the terminal (SIGHUP) no
// longer reaches it directly: neatroots has to stop on SIGHUP and take its agents with it.

const pkg = path.resolve(import.meta.dirname, "..");
const tsx = path.join(pkg, "node_modules", ".bin", "tsx");
let dir: string | undefined;
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await ok()) return true;
  return false;
};

describe.skipIf(process.platform === "win32")("closing the terminal neatroots runs in", () => {
  it("stops neatroots and the agent chat it was running, with what the agent started", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-hup-"));
    const pids = path.join(dir, "pids");
    // A stand-in agent CLI that starts a command of its own and keeps working.
    const agent = path.join(dir, "claude");
    fs.writeFileSync(agent, `#!/bin/sh\nsleep 30 &\necho "$$ $!" > "${pids}"\nwait\n`, { mode: 0o755 });
    const port = await freePort();
    const server = spawn(tsx, ["src/cli.ts", "start", "--port", String(port), "--grpc-port", "0", "--no-engine", "--no-laya"], {
      cwd: pkg,
      env: { ...process.env, HOME: dir, NEATROOTS_HOME: path.join(dir, "home"), NEATROOTS_CLAUDE_BIN: agent },
      stdio: "ignore",
      // Like a terminal's foreground job: neatroots (and the tsx wrapper) share one process group.
      detached: true,
    });
    leftovers.push(server.pid!);
    const url = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", origin: `http://localhost:${port}` };
    expect(await until(async () => (await fetch(`${url}/api/status`, { headers }).catch(() => undefined))?.ok === true, 30_000)).toBe(true);
    const s = (await (await fetch(`${url}/api/chat/sessions`, { method: "POST", headers, body: JSON.stringify({ agent: "claude", cwd: dir }) })).json()) as { id: string };
    await fetch(`${url}/api/chat/sessions/${s.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "keep going" }) });
    expect(await until(() => fs.existsSync(pids) && fs.readFileSync(pids, "utf8").trim().includes(" "), 10_000)).toBe(true);
    const [agentPid, commandPid] = fs.readFileSync(pids, "utf8").trim().split(" ").map(Number);
    leftovers.push(agentPid, commandPid);
    expect([alive(agentPid), alive(commandPid)]).toEqual([true, true]);

    // What a terminal does when its window closes: SIGHUP to its foreground process group.
    process.kill(-server.pid!, "SIGHUP");

    expect(await until(() => !alive(-server.pid!), 10_000)).toBe(true); // neatroots has stopped
    // was: the agent runs in its own session, so the hangup never reached it and it kept running
    expect(await until(() => !alive(agentPid) && !alive(commandPid), 5_000)).toBe(true);
  }, 60_000);
});
