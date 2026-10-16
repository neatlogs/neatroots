import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

// Chats with coding agents inside the app, run against stand-in CLIs that answer like the real ones.

const saved = { HOME: process.env.HOME, NEATROOTS_CODEX_BIN: process.env.NEATROOTS_CODEX_BIN, NEATROOTS_CLAUDE_BIN: process.env.NEATROOTS_CLAUDE_BIN };
let dir: string | undefined;
let t: TestRoots | undefined;
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t?.close();
  t = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const f = path.join(dir!, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}

describe("a chat with Codex", () => {
  it("sends a follow-up by resuming the session, without the --sandbox that `codex exec resume` rejects", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const log = path.join(dir, "args.log");
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      // The prompt (last) can span lines, so only the leading arguments are logged.
      `echo "$1 $2 $3 $4 $5 $6 $7" >> "${log}"
if [ "$1" = exec ] && [ "$2" = resume ]; then
  for a in "$@"; do [ "$a" = --sandbox ] && { echo "error: unexpected argument '--sandbox' found" >&2; exit 2; }; done
fi
echo '{"type":"thread.started","thread_id":"thread_t"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir, allow_edits: true });
    await t.roots.chats.send(s.id, "hi");
    await t.roots.chats.send(s.id, "and again");
    const events = t.roots.chats.events(s.id);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.filter((e) => e.kind === "text").map((e) => e.text)).toEqual(["OK", "OK"]);
    const [first, second] = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(first).toMatch(/--sandbox workspace-write/);
    expect(second).toMatch(/^exec resume thread_t .*-c sandbox_mode="workspace-write"/);
  });
});

describe("a chat with Claude Code whose sign-in has expired", () => {
  it("explains what to do, once", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const err = "API Error: Could not load AWS credentials · Your session has expired. Please reauthenticate.";
    // What Claude Code on Amazon Bedrock streams when its AWS session has expired.
    process.env.NEATROOTS_CLAUDE_BIN = script(
      "claude",
      `echo '{"type":"system","subtype":"init","session_id":"s1","model":"us.anthropic.claude-opus-5-5","mcp_servers":[]}'
echo '{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"${err}"}]}}'
echo '{"type":"result","subtype":"success","is_error":true,"result":"${err}","session_id":"s1","duration_ms":3105,"total_cost_usd":0}'`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "claude", cwd: dir });
    await t.roots.chats.send(s.id, "how many projects?");
    const events = t.roots.chats.events(s.id);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toMatch(/Claude Code couldn't sign in[\s\S]*Amazon Bedrock[\s\S]*Could not load AWS credentials/);
    expect(events.find((e) => e.kind === "result")?.text).toBeUndefined();
  });
});

describe("an agent still answering", () => {
  // A stand-in agent that starts a command of its own (like a shell tool call) and keeps working.
  const setup = async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const pids = path.join(dir, "pids");
    process.env.NEATROOTS_CLAUDE_BIN = script("claude", `sleep 30 &\necho "$$ $!" > "${pids}"\nwait`);
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "claude", cwd: dir });
    const turn = t.roots.chats.send(s.id, "keep going");
    for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 20));
    const [agent, command] = fs.readFileSync(pids, "utf8").trim().split(" ").map(Number);
    return { s, turn, agent, command };
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (...ids: number[]) => {
    for (let i = 0; i < 50 && ids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
    return ids.map(alive);
  };

  it("is ended, with what it started, when neatroots stops", async () => {
    const { agent, command } = await setup();
    try {
      expect([alive(agent), alive(command)]).toEqual([true, true]);
      await t!.close(); // what Ctrl-C and the service stopping do
      t = undefined;
      expect(await gone(agent, command)).toEqual([false, false]); // was: both kept running
    } finally {
      for (const pid of [agent, command]) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("is ended, with what it started, by Stop", async () => {
    const { s, turn, agent, command } = await setup();
    try {
      expect(t!.roots.chats.stop(s.id)).toBe(true);
      await turn;
      expect(await gone(agent, command)).toEqual([false, false]); // was: the command it started kept running
      expect(t!.roots.chats.events(s.id).some((e) => e.kind === "status" && e.text === "Stopped")).toBe(true);
    } finally {
      for (const pid of [agent, command]) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});
