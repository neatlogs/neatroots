import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRoots, until, type TestRoots } from "./helpers.js";

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

describe("a chat with Codex whose message starts with a dash", () => {
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

describe("deleting a running chat", () => {
  it("ignores the child process's late events and exit", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-chat-"));
    process.env.HOME = dir;
    process.env.NEATROOTS_CODEX_BIN = script("codex", "sleep 30");
    t = await makeRoots({ noEngine: true });
    const s = t.roots.chats.create({ agent: "codex", cwd: dir });
    const sending = t.roots.chats.send(s.id, "keep working");
    await until(() => t!.roots.chats.get(s.id)?.state === "running");

    t.roots.chats.remove(s.id);
    await sending;

    expect(t.roots.chats.get(s.id)).toBeUndefined();
    expect(t.roots.chats.events(s.id)).toEqual([]);
  });
});
