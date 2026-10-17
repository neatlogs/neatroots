import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentBin, signInHelp } from "../src/agents/chat.js";

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, NEATROOTS_CODEX_BIN: process.env.NEATROOTS_CODEX_BIN };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-agents-"));
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  process.env.PATH = "/usr/bin:/bin";
  delete process.env.NEATROOTS_CODEX_BIN;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeBin(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
  return f;
}

describe("finding a coding agent's CLI", () => {
  // These discovery fixtures use POSIX executable scripts and shell PATH lookup.
  it.skipIf(process.platform === "win32")("looks past the PATH: an npm install under any nvm Node, or ~/.local/bin", () => {
    const nvm = fakeBin(path.join(home, ".nvm", "versions", "node", "v24.14.1", "bin"), "codex");
    expect(agentBin("codex")).toBe(nvm);
    const local = fakeBin(path.join(home, ".local", "bin"), "codex");
    expect(agentBin("codex")).toBe(local);
  });

  it("accepts an explicit native executable override without PATH lookup", () => {
    process.env.PATH = "";
    process.env.NEATROOTS_CODEX_BIN = process.execPath;
    expect(agentBin("codex")).toBe(process.execPath);
    process.env.NEATROOTS_CODEX_BIN = path.join(home, "missing");
    expect(agentBin("codex")).toBeNull();
  });

  const chatgpt = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  it.runIf(fs.existsSync(chatgpt))("finds the Codex that ships inside ChatGPT.app", () => {
    expect(agentBin("codex")).toBe(chatgpt);
  });

  it.skipIf(process.platform === "win32")("prefers the PATH, and NEATROOTS_CODEX_BIN over everything", () => {
    const onPath = fakeBin(path.join(home, "bin"), "codex");
    fakeBin(path.join(home, ".local", "bin"), "codex");
    process.env.PATH = `${path.join(home, "bin")}:/usr/bin:/bin`;
    expect(agentBin("codex")).toBe(onPath);
    const pinned = fakeBin(path.join(home, "pinned"), "codex-dev");
    process.env.NEATROOTS_CODEX_BIN = pinned;
    expect(agentBin("codex")).toBe(pinned);
    process.env.NEATROOTS_CODEX_BIN = path.join(home, "missing");
    expect(agentBin("codex")).toBeNull();
  });
});

describe("sign-in failures", () => {
  it("turn the CLI's auth errors into what to do", () => {
    const bedrock = signInHelp("claude", "API Error: Could not load AWS credentials · Your session has expired. Please reauthenticate.");
    expect(bedrock).toMatch(/Claude Code couldn't sign in/);
    expect(bedrock).toMatch(/Amazon Bedrock/);
    expect(signInHelp("claude", "Failed to authenticate: OAuth session expired and could not be refreshed")).toMatch(/Run `claude` in a terminal/);
    expect(signInHelp("codex", "401 Unauthorized")).toMatch(/Codex couldn't sign in/);
    expect(signInHelp("claude", "The file was not found")).toBeNull();
  });
});
