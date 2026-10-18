import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientStatus, connectClient, disconnectClient, findClient } from "../src/mcp/clients.js";

const cmd = { command: "/opt/neatroots/bin/neatroots", args: ["mcp"] };
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-clients-"));
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  process.env.PATH = "";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const read = (p: string) => JSON.parse(fs.readFileSync(path.join(home, p), "utf8"));

describe("coding-agent MCP setup", () => {
  it("adds to Cursor's mcp.json and keeps the servers already there", () => {
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.writeFileSync(path.join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    const cursor = findClient("cursor")!;
    expect(clientStatus(cursor)).toMatchObject({ detected: true, connected: false });
    expect(connectClient(cursor, cmd).ok).toBe(true);
    expect(read(".cursor/mcp.json")).toEqual({ mcpServers: { other: { command: "x" }, neatroots: cmd }, theme: "dark" });
    expect(fs.existsSync(path.join(home, ".cursor/mcp.json.neatroots-backup"))).toBe(true);
    expect(clientStatus(cursor).connected).toBe(true);
    expect(disconnectClient(cursor).ok).toBe(true);
    expect(read(".cursor/mcp.json").mcpServers).toEqual({ other: { command: "x" } });
  });

  it("writes each agent's own shape", () => {
    connectClient(findClient("opencode")!, cmd);
    expect(read(".config/opencode/opencode.json").mcp.neatroots).toEqual({ type: "local", command: ["/opt/neatroots/bin/neatroots", "mcp"], enabled: true });
    connectClient(findClient("amp")!, cmd);
    expect(read(".config/amp/settings.json")["amp.mcpServers"].neatroots).toEqual(cmd);
    connectClient(findClient("gemini")!, cmd);
    expect(read(".gemini/settings.json").mcpServers.neatroots).toEqual(cmd);
    connectClient(findClient("windsurf")!, cmd);
    expect(read(".codeium/windsurf/mcp_config.json").mcpServers.neatroots).toEqual(cmd);
  });

  it("leaves a file with comments alone and says what to add", () => {
    fs.mkdirSync(path.join(home, ".gemini"));
    const text = '{\n  // my settings\n  "theme": "dark"\n}\n';
    fs.writeFileSync(path.join(home, ".gemini/settings.json"), text);
    const r = connectClient(findClient("gemini")!, cmd);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('"neatroots"');
    expect(fs.readFileSync(path.join(home, ".gemini/settings.json"), "utf8")).toBe(text);
  });

  it("adds and removes a Codex table without touching the rest of config.toml", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    connectClient(codex, cmd);
    connectClient(codex, cmd); // twice: still one table
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(text.match(/\[mcp_servers\.neatroots\]/g)).toHaveLength(1);
    expect(text).toContain('command = "/opt/neatroots/bin/neatroots"\nargs = ["mcp"]');
    expect(text).toContain("[mcp_servers.other]");
    expect(clientStatus(codex).connected).toBe(true);
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(before);
  });

  // Agent configs often hold other MCP servers' tokens in their env blocks.
  it.skipIf(process.platform === "win32")("keeps a private config file private", () => {
    fs.mkdirSync(path.join(home, ".cursor"));
    const json = path.join(home, ".cursor/mcp.json");
    fs.writeFileSync(json, JSON.stringify({ mcpServers: { github: { command: "x", env: { GITHUB_TOKEN: "ghp_secret" } } } }), { mode: 0o600 });
    fs.mkdirSync(path.join(home, ".codex"));
    const toml = path.join(home, ".codex/config.toml");
    fs.writeFileSync(toml, '[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_secret"\n', { mode: 0o600 });
    connectClient(findClient("cursor")!, cmd);
    connectClient(findClient("codex")!, cmd);
    expect(fs.statSync(json).mode & 0o777).toBe(0o600);
    expect(fs.statSync(toml).mode & 0o777).toBe(0o600);
    disconnectClient(findClient("cursor")!);
    expect(fs.statSync(json).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("edits a symlinked config through the link and keeps the link", () => {
    const real = path.join(home, "dotfiles/cursor-mcp.json");
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    fs.mkdirSync(path.join(home, ".cursor"));
    const link = path.join(home, ".cursor/mcp.json");
    fs.symlinkSync(real, link);
    expect(connectClient(findClient("cursor")!, cmd).ok).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers).toEqual({ other: { command: "x" }, neatroots: cmd });
  });

  it("installs neatroots' skills where Codex reads them, and removes them on disconnect", () => {
    const codex = findClient("codex")!;
    expect(connectClient(codex, cmd).message).toContain("4 skills");
    const skill = path.join(home, ".agents/skills/neatroots-debug-last-run/SKILL.md");
    expect(fs.readFileSync(skill, "utf8")).toContain("name: neatroots-debug-last-run");
    expect(clientStatus(codex).skills).toBe(true);
    fs.mkdirSync(path.join(home, ".agents/skills/someone-else"));
    disconnectClient(codex);
    expect(fs.existsSync(skill)).toBe(false);
    expect(fs.existsSync(path.join(home, ".agents/skills/someone-else"))).toBe(true);
  });

  it("knows Claude Code from ~/.claude.json and needs its CLI to change it", () => {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { neatroots: cmd } }));
    const claude = findClient("claude")!;
    expect(clientStatus(claude).connected).toBe(true);
    const r = connectClient(claude, cmd);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("claude mcp add --scope user neatroots -- /opt/neatroots/bin/neatroots mcp");
  });
});
