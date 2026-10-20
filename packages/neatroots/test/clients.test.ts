import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientStatus, connectClient, disconnectClient, findClient } from "../src/mcp/clients.js";
import { scanToml } from "../src/mcp/toml-entry.js";

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

  it("replaces a quoted [mcp_servers.\"neatroots\"] table instead of adding a second, invalid one", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = 'model = "gpt-5"\n\n[mcp_servers."neatroots"]\ncommand = "stale"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    // Quoted and bare spell the same table name, so this file already connects Codex.
    expect(clientStatus(codex).connected).toBe(true);
    expect(connectClient(codex, cmd).ok).toBe(true);
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    // One table for us, spelled bare; the stale quoted one is gone. Two definitions of
    // the same table are invalid TOML and would stop Codex reading its whole config.
    expect(text.match(/\[mcp_servers\.neatroots\]/g)).toHaveLength(1);
    expect(text).not.toContain('command = "stale"');
    expect(text).toContain('command = "/opt/neatroots/bin/neatroots"');
    expect(text).toContain("[mcp_servers.other]");
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  });

  it("does not read a bracketed line inside a multi-line string as a table", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = 'instructions = """\nexample:\n[mcp_servers.neatroots]\ncommand = "stale"\n"""\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    connectClient(codex, cmd);
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    // The string keeps its closing delimiter and its contents; dropping them would leave
    // one unterminated multi-line string swallowing the rest of the file.
    expect(text).toContain('[mcp_servers.neatroots]\ncommand = "stale"\n"""');
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(before);
  });

  it("clears our entry however TOML spells it: quoted legacy names, sub-tables, dotted keys", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before =
      'mcp_servers.neatroots = { command = "stale" }\n\n[mcp_servers."neatbolt".env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    expect(connectClient(codex, cmd).ok).toBe(true);
    let text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(text).not.toContain("neatbolt");
    expect(text).not.toContain('"stale"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text.match(/\[mcp_servers\.neatroots\]/g)).toHaveLength(1);
    disconnectClient(codex);
    text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(text).not.toContain("neatbolt");
    expect(text).not.toContain("[mcp_servers.neatroots]");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain('command = "x"');
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

  it("stops TOML scanning at an unquoted # so a comment containing \"\"\" cannot open a string", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = '# use """ for long strings\n\n[mcp_servers.neatroots]\ncommand = "stale"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    // The comment's quotes must not open a multi-line string that swallows our table.
    expect(clientStatus(codex).connected).toBe(true);
    expect(connectClient(codex, cmd).ok).toBe(true);
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(text.match(/\[mcp_servers\.neatroots\]/g)).toHaveLength(1);
    expect(text).toContain('# use """ for long strings');
    expect(text).not.toContain('command = "stale"');
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      '# use """ for long strings\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
  });

  it("drops a dotted key of ours together with its multi-line value", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = '[mcp_servers]\nother = 1\nneatroots.description = """\nline with [mcp_servers.fake]\n"""\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    connectClient(codex, cmd);
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    // The dotted key goes with its whole value: no leftover body, no stray closing delimiter.
    expect(text).not.toContain("neatroots.description");
    expect(text).not.toContain("line with [mcp_servers.fake]");
    expect(text.split('"""')).toHaveLength(1); // no stray multi-line delimiters left behind
    expect(text).toContain("other = 1");
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      '[mcp_servers]\nother = 1\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
  });

  it("status counts only the current server name, while removal still clears legacy names", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex/config.toml"), '[mcp_servers.neatbolt]\ncommand = "old"\n');
    const codex = findClient("codex")!;
    // A legacy-only entry is not the neatroots MCP server; jsonHas never counted it either.
    expect(clientStatus(codex).connected).toBe(false);
    disconnectClient(codex); // cleanup still strips it
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe("");
  });

  it("collapses blank lines only where our entry was removed, byte-exact elsewhere", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = 'a = """\nx\n\n\ny"""\n\n[mcp_servers.neatroots]\ncommand = "stale"\n\n[z]\nb = 2\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    connectClient(codex, cmd);
    disconnectClient(codex);
    // The two blank lines inside the other entry's multi-line string are content.
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe('a = """\nx\n\n\ny"""\n\n[z]\nb = 2\n');
  });

  it("reads a table header with a trailing comment as our table", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const before = 'top = 1\n\n[mcp_servers.neatroots] # neatroots\ncommand = "stale"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), before);
    const codex = findClient("codex")!;
    expect(clientStatus(codex).connected).toBe(true);
    expect(connectClient(codex, cmd).ok).toBe(true);
    const text = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(text.match(/\[mcp_servers\.neatroots\]/g)).toHaveLength(1);
    expect(text).not.toContain('"stale"');
    disconnectClient(codex);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      'top = 1\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
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

describe("toml entry scanning (review round 2 regressions)", () => {
  it("drops a multi-line array after a multi-line value inside our own table", () => {
    const text = [
      '[mcp_servers.neatroots]',
      'command = "stale"',
      'description = """',
      'hello',
      '"""',
      'args = [',
      '  "--stdio",',
      ']',
      'other_key = 1',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      '',
    ].join("\n");
    const out = scanToml(text);
    expect(out.server).toBe(true);
    // Everything from our header to the next header goes: a closed multi-line value
    // must not end the skip while we are still inside our table.
    expect(out.text).not.toContain("hello");
    expect(out.text).not.toContain("--stdio");
    expect(out.text).not.toContain("other_key");
    expect(out.text).toContain('[mcp_servers.other]\ncommand = "x"');
  });

  it("drops a dotted key's multi-line array under [mcp_servers]", () => {
    const text = [
      '[mcp_servers]',
      'neatroots.args = [',
      '  "--stdio",',
      ']',
      'keep = 1',
      '',
    ].join("\n");
    const out = scanToml(text);
    expect(out.server).toBe(true);
    // the array's lines and its closing bracket go with the key: leftover "]" or
    // '"--stdio",' would be invalid TOML.
    expect(out.text).toBe("[mcp_servers]\nkeep = 1\n");
  });

  it("an escaped backslash before the closing delimiter does not swallow the file (open tracking)", () => {
    // TOML source 's = """C:\\"""' is a closed string (\\ is one escaped backslash), so the
    // table below is real and must be seen.
    const text = 's = """C:\\\\"""\n\n[mcp_servers.neatroots]\ncommand = "stale"\n';
    const out = scanToml(text);
    expect(out.server).toBe(true);
    expect(out.text).not.toContain('command = "stale"');
  });

  it("an escaped backslash before the closing delimiter does not swallow the file (comment stripping)", () => {
    const text = 's = """C:\\\\""" # note\n[mcp_servers.neatroots]\ncommand = "stale"\n';
    const out = scanToml(text);
    expect(out.server).toBe(true);
    expect(out.text).not.toContain('command = "stale"');
  });
});
