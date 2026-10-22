import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRoots, poll, type TestRoots } from "./helpers.js";

// These integration fixtures execute POSIX shell scripts. Native Windows agent launching
// needs separate executable fixtures; do not replace process execution with canned success.

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

describe.skipIf(process.platform === "win32")("a chat with Codex", () => {
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
    const s = t.roots.chats.create({ agent: "codex", cwd: dir, allow_edits: true, allow_commands: true });
    await t.roots.chats.send(s.id, "hi");
    await t.roots.chats.send(s.id, "and again");
    const events = t.roots.chats.events(s.id);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.filter((e) => e.kind === "text").map((e) => e.text)).toEqual(["OK", "OK"]);
    const [first, second] = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(first).toMatch(/--sandbox workspace-write/);
    expect(second).toMatch(/^exec resume thread_t .*-c sandbox_mode="workspace-write"/);
  });

  it("uses workspace-write only when both edits and commands are allowed", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const log = path.join(dir, "args.log");
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      `echo "$1 $2 $3 $4 $5" >> "${log}"
echo '{"type":"thread.started","thread_id":"thread_t"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    t = await makeRoots({ noEngine: true });
    for (const permissions of [
      { allow_edits: false, allow_commands: false },
      { allow_edits: true, allow_commands: false },
      { allow_edits: false, allow_commands: true },
      { allow_edits: true, allow_commands: true },
    ]) {
      const s = t.roots.chats.create({ agent: "codex", cwd: dir, ...permissions });
      await t.roots.chats.send(s.id, "hi");
    }
    expect(fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.match(/--sandbox (\S+)/)?.[1])).toEqual([
      "read-only",
      "read-only",
      "read-only",
      "workspace-write",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("a read-only chat with Claude Code", () => {
  it("pre-approves only MCP tools marked read-only", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const log = path.join(dir, "tools.log");
    process.env.NEATROOTS_CLAUDE_BIN = script(
      "claude",
      `prev=""
for a in "$@"; do
  [ "$prev" = "--allowedTools" ] && printf '%s' "$a" > "${log}"
  prev="$a"
done
echo '{"type":"system","subtype":"init","session_id":"s1","model":"claude","mcp_servers":[]}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"s1"}'`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "claude", cwd: dir });
    await t.roots.chats.send(s.id, "inspect the run");

    const allowed = fs.readFileSync(log, "utf8").split(",");
    expect(allowed).toContain("mcp__neatroots__get_current_run");
    expect(allowed).toContain("mcp__neatroots_app__query_sql");
    expect(allowed).not.toContain("mcp__neatroots__create_check");
    expect(allowed).not.toContain("mcp__neatroots__rerun");
    expect(allowed).not.toContain("mcp__neatroots__replay");
    expect(allowed.some((tool) => tool.endsWith("__*"))).toBe(false);
  });
});

function nodeScript(name: string, body: string): string {
  const f = path.join(dir!, name);
  fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return f;
}

describe.skipIf(process.platform === "win32")("a chat whose agent splits multibyte UTF-8 across pipe chunks (#616)", () => {
  it("decodes stdout without replacement characters", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const text = "h\u00e9llo \ud83d\ude00 \u4e16\u754c";
    process.env.NEATROOTS_CODEX_BIN = nodeScript(
      "codex",
      `const text = ${JSON.stringify(text)};
const line1 = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } });
const line2 = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
const out = Buffer.concat([Buffer.from(line1 + "\\n", "utf8"), Buffer.from(line2 + "\\n", "utf8")]);
const cut = out.indexOf(0xf0) + 2; // mid-character
process.stdout.write(out.subarray(0, cut), () => setTimeout(() => process.stdout.write(out.subarray(cut)), 50));`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    await t.roots.chats.send(s.id, "hi");
    await poll(async () => t!.roots.chats.events(s.id).some((e) => e.kind === "text"));
    const texts = t.roots.chats.events(s.id).filter((e) => e.kind === "text").map((e) => e.text);
    expect(texts).toEqual([text]);
    expect(texts.join("")).not.toContain("\ufffd");
  });

  it("decodes stderr without replacement characters when the turn fails", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const warning = "provider warning: h\u00e9llo \ud83d\ude00 \u4e16\u754c";
    process.env.NEATROOTS_CODEX_BIN = nodeScript(
      "codex",
      `const err = Buffer.from(${JSON.stringify(warning + "\n")}, "utf8");
const cut = err.indexOf(0xf0) + 2; // mid-character
process.stderr.write(err.subarray(0, cut), () => setTimeout(() => process.stderr.write(err.subarray(cut), () => process.exit(2)), 50));`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    await t.roots.chats.send(s.id, "hi");
    await poll(async () => t!.roots.chats.events(s.id).some((e) => e.kind === "error"));
    const errors = t.roots.chats.events(s.id).filter((e) => e.kind === "error").map((e) => e.text);
    expect(errors).toEqual([warning]);
    expect(errors.join("")).not.toContain("\ufffd");
  });
});

describe.skipIf(process.platform === "win32")("deleting a chat while the agent is answering", () => {
  it("cancels it and writes no further events for the removed session", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      `echo '{"type":"thread.started","thread_id":"thread_t"}'
sleep 0.4
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"late"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    const turn = t.roots.chats.send(s.id, "hi");
    await new Promise((r) => setTimeout(r, 150));
    expect(t.roots.chats.get(s.id)?.state).toBe("running");
    t.roots.chats.remove(s.id);
    await turn;
    await new Promise((r) => setTimeout(r, 600));
    expect(t.roots.chats.get(s.id)).toBeUndefined();
    expect(t.roots.chats.events(s.id)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a chat with Claude Code whose sign-in has expired", () => {
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

describe.skipIf(process.platform === "win32")("an agent still answering", () => {
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

describe.skipIf(process.platform === "win32")("stopping a chat turn (#23.19)", () => {
  it("ends the turn and stops what the agent started, even when a child holds its output open", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const childPid = path.join(dir, "child.pid");
    // An agent whose tool keeps running (and keeps stdout open) until it is stopped.
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      `echo '{"type":"thread.started","thread_id":"thread_s"}'
sleep 60 &
echo $! > "${childPid}"
wait`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    const turn = t.roots.chats.send(s.id, "run a long tool");
    await poll(async () => fs.existsSync(childPid) && fs.readFileSync(childPid, "utf8").trim());
    const pid = Number(fs.readFileSync(childPid, "utf8").trim());
    expect(t.roots.chats.stop(s.id)).toBe(true);
    await turn;
    expect(t.roots.chats.get(s.id)!.state).toBe("idle");
    expect(t.roots.chats.events(s.id).some((e) => e.kind === "status" && e.text === "Stopped")).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await poll(async () => !alive(), 5000);
  }, 20_000);
});

describe.skipIf(process.platform === "win32")("stopping a chat turn whose tool ignores SIGTERM", () => {
  it("still kills the tool after the escalation deadline, though the turn has already ended", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const childPid = path.join(dir, "child.pid");
    // The CLI exits on SIGTERM; the tool it started ignores SIGTERM and keeps stdout open.
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      `echo '{"type":"thread.started","thread_id":"thread_k"}'
"${process.execPath}" -e 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${childPid}" &
wait`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    const turn = t.roots.chats.send(s.id, "run a stubborn tool");
    await poll(async () => fs.existsSync(childPid) && fs.readFileSync(childPid, "utf8").trim());
    const pid = Number(fs.readFileSync(childPid, "utf8").trim());
    expect(t.roots.chats.stop(s.id)).toBe(true);
    await turn;
    expect(t.roots.chats.get(s.id)!.state).toBe("idle");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await poll(async () => !alive(), 8000);
  }, 20_000);
});

describe.skipIf(process.platform === "win32")("a chat with Codex whose message starts with a dash", () => {
  it("passes the prompt after -- so codex never reads it as a flag, for new and resumed sessions", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const log = path.join(dir, "args.log");
    process.env.NEATROOTS_CODEX_BIN = script(
      "codex",
      // Codex's parser (clap) reads a bare prompt that starts with - as an option and exits 2;
      // anything after -- is positional. One arg per line so a multi-line prompt can't fake a match.
      `printf '%s\\n' "$@" >> "${log}"
printf '%s\\n' ---- >> "${log}"
dd=0
prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ] || [ "$prev" = "--sandbox" ]; then prev=""; continue; fi
  case "$a" in
    --) dd=1 ;;
    --json|--skip-git-repo-check|-c|--sandbox) ;;
    -*) [ "$dd" = 0 ] && { echo "error: unexpected argument '$a' found" >&2; exit 2; } ;;
  esac
  prev="$a"
done
echo '{"type":"thread.started","thread_id":"thread_t"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    await t.roots.chats.send(s.id, "hi");
    await t.roots.chats.send(s.id, "- list the files");
    const events = t.roots.chats.events(s.id);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.filter((e) => e.kind === "text").map((e) => e.text)).toEqual(["OK", "OK"]);
    // Both calls must put -- right before the prompt: the first call's prompt is the preamble
    // plus "hi", the follow-up's is "- list the files".
    const calls = fs.readFileSync(log, "utf8").split("----\n").filter((c) => c.trim());
    expect(calls).toHaveLength(2);
    calls.forEach((call, i) => {
      // The prompt is one arg but can span lines; everything after the -- line is the prompt.
      const lines = call.trimEnd().split("\n");
      expect(lines.filter((a) => a === "--")).toHaveLength(1);
      const prompt = lines.slice(lines.indexOf("--") + 1).join("\n");
      expect(prompt.endsWith(i === 0 ? "hi" : "- list the files")).toBe(true);
    });
  });
});

describe.skipIf(process.platform === "win32")("a read-only chat with Claude Code", () => {
  it("denies edit, command and rerun tools until the chat allows them, whatever the user's own settings allow", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    const log = path.join(dir, "args.log");
    process.env.NEATROOTS_CLAUDE_BIN = script(
      "claude",
      `printf '%s\\n' "$@" >> "${log}"
printf '%s\\n' ---- >> "${log}"
echo '{"type":"system","subtype":"init","session_id":"s1","model":"m","mcp_servers":[]}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}'`,
    );
    t = await makeRoots({ noEngine: true });
    const denied = () => {
      const calls = fs.readFileSync(log, "utf8").split("----\n").filter((c) => c.trim());
      const args = calls[calls.length - 1].split("\n");
      const at = args.indexOf("--disallowedTools");
      return at < 0 ? [] : args[at + 1].split(",");
    };
    const readOnly = t.roots.chats.create({ agent: "claude", cwd: dir });
    await t.roots.chats.send(readOnly.id, "look around");
    expect(denied()).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "mcp__neatroots__rerun", "mcp__neatroots_app__rerun"]));
    const commands = t.roots.chats.create({ agent: "claude", cwd: dir, allow_commands: true });
    await t.roots.chats.send(commands.id, "run the tests");
    expect(denied()).toEqual(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
    const both = t.roots.chats.create({ agent: "claude", cwd: dir, allow_edits: true, allow_commands: true });
    await t.roots.chats.send(both.id, "fix it");
    expect(denied()).toEqual([]);
  });
});
