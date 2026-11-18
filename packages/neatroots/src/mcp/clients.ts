import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Registers neatroots's MCP server with coding agents, each in the format its own docs give.
// File-based clients are edited in place: other entries are kept, a backup is made before the
// first change, and a file we can't parse (comments, say) is left alone with instructions instead.

// The TOML scanner lives in ./toml-entry.js (it has its own rules for comments,
// multi-line strings and byte-exact removal).
import { LEGACY_NAMES, SERVER_NAME, stripTomlEntry, tomlHas } from "./toml-entry.js";

export { SERVER_NAME };

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface ClientStatus {
  id: string;
  label: string;
  /** The agent looks installed on this machine. */
  detected: boolean;
  connected: boolean;
  /** Where the entry lives (a file), or the CLI that manages it. */
  where: string;
  /** Shown after connecting, e.g. "restart Cursor". */
  note?: string;
  /** neatroots skills installed in this agent, if it supports skills. */
  skills?: boolean;
}

export interface ConnectResult {
  id: string;
  ok: boolean;
  message: string;
}

type Shape = "mcpServers" | "amp" | "opencode" | "vscode";

interface ClientDef {
  id: string;
  label: string;
  /** Executables or folders whose presence means the agent is installed. */
  bins?: string[];
  dirs?: () => string[];
  /** JSON config edited in place. */
  json?: { file: () => string; shape: Shape };
  toml?: { file: () => string };
  /** Managed through its own CLI (Claude Code). */
  cli?: "claude";
  /** Where the agent reads user-level skills (SKILL.md folders), if it supports them. */
  skills?: () => string;
  note?: string;
}

const home = () => os.homedir();
const appSupport = (...p: string[]) =>
  process.platform === "darwin" ? path.join(home(), "Library", "Application Support", ...p) : path.join(home(), ".config", ...p);

export const CLIENTS: ClientDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bins: ["claude"],
    dirs: () => [path.join(home(), ".claude")],
    cli: "claude",
    skills: () => path.join(home(), ".claude", "skills"),
  },
  {
    id: "codex",
    label: "Codex",
    bins: ["codex"],
    dirs: () => [path.join(home(), ".codex")],
    toml: { file: () => path.join(home(), ".codex", "config.toml") },
    skills: () => path.join(home(), ".agents", "skills"),
  },
  {
    id: "cursor",
    label: "Cursor",
    bins: ["cursor"],
    dirs: () => [path.join(home(), ".cursor"), "/Applications/Cursor.app"],
    json: { file: () => path.join(home(), ".cursor", "mcp.json"), shape: "mcpServers" },
    note: "Cursor picks it up in Settings → MCP; reload the window if it doesn't appear.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bins: ["opencode"],
    dirs: () => [path.join(home(), ".config", "opencode")],
    json: { file: () => path.join(home(), ".config", "opencode", "opencode.json"), shape: "opencode" },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bins: ["windsurf"],
    dirs: () => [path.join(home(), ".codeium", "windsurf"), "/Applications/Windsurf.app"],
    json: { file: () => path.join(home(), ".codeium", "windsurf", "mcp_config.json"), shape: "mcpServers" },
    note: "Refresh the MCP list in Windsurf's Cascade panel.",
  },
  {
    id: "amp",
    label: "Amp",
    bins: ["amp"],
    dirs: () => [path.join(home(), ".config", "amp")],
    json: { file: () => path.join(home(), ".config", "amp", "settings.json"), shape: "amp" },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bins: ["gemini"],
    dirs: () => [path.join(home(), ".gemini")],
    json: { file: () => path.join(home(), ".gemini", "settings.json"), shape: "mcpServers" },
  },
  {
    id: "vscode",
    label: "VS Code",
    bins: ["code"],
    dirs: () => [appSupport("Code", "User")],
    json: { file: () => appSupport("Code", "User", "mcp.json"), shape: "vscode" },
    note: "VS Code asks you to trust the server the first time Copilot uses it.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    dirs: () => [appSupport("Claude")],
    json: { file: () => appSupport("Claude", "claude_desktop_config.json"), shape: "mcpServers" },
    note: "Quit and reopen Claude Desktop to load it.",
  },
];

export function findClient(id: string): ClientDef | undefined {
  const k = id.toLowerCase();
  return CLIENTS.find((c) => c.id === k || c.label.toLowerCase() === k || (k === "claude" && c.id === "claude-code"));
}

function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/**
 * What a coding agent should run. The installer's wrapper (`~/.local/bin/neatroots`) survives
 * updates, so it is preferred; otherwise this Node and this CLI, by absolute path, since GUI
 * apps don't see your shell's PATH.
 */
export function serverCommand(): ServerCommand {
  const wrapper = process.env.NEATROOTS_WRAPPER;
  if (wrapper && fs.existsSync(wrapper)) return { command: wrapper, args: ["mcp"] };
  const cli = process.argv[1] ? fs.realpathSync(process.argv[1]) : "neatroots";
  return { command: process.execPath, args: [cli, "mcp"] };
}

// ------------------------------------------------------------------ JSON

function readJson(file: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!fs.existsSync(file)) return { ok: true, data: {} };
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return { ok: true, data: {} };
  try {
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "it isn't a JSON object" };
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false, error: "it isn't plain JSON (comments or trailing commas?), so it was left as it is" };
  }
}

function writeFileSafely(file: string, text: string): void {
  // A config linked from a dotfiles repo is edited where the link points, so the link stays.
  // The new file keeps the old one's permissions: these files can hold other servers' tokens.
  let target = file;
  let mode: number | undefined;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* a new file */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = `${file}.neatroots-backup`;
  if (mode !== undefined && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
  const tmp = `${target}.neatroots-tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode: mode ?? 0o666 });
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

const KEY: Record<Shape, string> = { mcpServers: "mcpServers", amp: "amp.mcpServers", opencode: "mcp", vscode: "servers" };

function entryFor(shape: Shape, cmd: ServerCommand): Record<string, unknown> {
  if (shape === "opencode") return { type: "local", command: [cmd.command, ...cmd.args], enabled: true };
  if (shape === "vscode") return { type: "stdio", command: cmd.command, args: cmd.args };
  return { command: cmd.command, args: cmd.args };
}

function jsonHas(file: string, shape: Shape): boolean {
  const r = readJson(file);
  if (!r.ok) return false;
  const servers = r.data[KEY[shape]];
  return !!servers && typeof servers === "object" && SERVER_NAME in (servers as object);
}

function jsonSet(file: string, shape: Shape, cmd: ServerCommand | null): string | null {
  const r = readJson(file);
  if (!r.ok) return `couldn't edit ${file}: ${r.error}`;
  const key = KEY[shape];
  const servers = { ...((r.data[key] as Record<string, unknown> | undefined) ?? {}) };
  const legacy = LEGACY_NAMES.filter((n) => n in servers);
  for (const n of legacy) delete servers[n];
  if (cmd) servers[SERVER_NAME] = entryFor(shape, cmd);
  else if (SERVER_NAME in servers) delete servers[SERVER_NAME];
  else if (!legacy.length) return null;
  writeFileSafely(file, `${JSON.stringify({ ...r.data, [key]: servers }, null, 2)}\n`);
  return null;
}

// ------------------------------------------------------------------ TOML
function tomlSet(file: string, cmd: ServerCommand | null): void {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let text = stripTomlEntry(before).trimEnd();
  if (cmd) {
    const q = (s: string) => JSON.stringify(s);
    text += `${text ? "\n\n" : ""}[mcp_servers.${SERVER_NAME}]\ncommand = ${q(cmd.command)}\nargs = [${cmd.args.map(q).join(", ")}]`;
  }
  if (text + "\n" !== before) writeFileSafely(file, text ? `${text}\n` : "");
}

// ------------------------------------------------------------ Claude Code

function claudeCodeConnected(): boolean {
  // `claude mcp add --scope user` stores the entry at the top level of ~/.claude.json.
  const r = readJson(path.join(home(), ".claude.json"));
  return r.ok && !!r.data.mcpServers && SERVER_NAME in (r.data.mcpServers as object);
}

function claudeCli(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("claude", args, { encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// ---------------------------------------------------------------- skills

/** The skills shipped with neatroots (skills/neatroots-*), found next to the bundle or the checkout. */
export function skillsSource(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "skills");
    if (fs.existsSync(candidate) && fs.readdirSync(candidate).some((d) => d.startsWith("neatroots-"))) return candidate;
    dir = path.dirname(dir);
  }
  return undefined;
}

function ourSkills(): string[] {
  const src = skillsSource();
  return src ? fs.readdirSync(src).filter((d) => d.startsWith("neatroots-") && fs.existsSync(path.join(src, d, "SKILL.md"))) : [];
}

function skillsInstalled(c: ClientDef): boolean {
  const names = ourSkills();
  return !!c.skills && names.length > 0 && names.every((n) => fs.existsSync(path.join(c.skills!(), n, "SKILL.md")));
}

/** Copies (or refreshes) neatroots' skills into the agent's user skills folder. Returns how many. */
function installSkills(c: ClientDef): number {
  const src = skillsSource();
  if (!c.skills || !src) return 0;
  const names = ourSkills();
  removeLegacySkills(c);
  for (const n of names) {
    const dest = path.join(c.skills(), n);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(src, n), dest, { recursive: true, filter: (f) => !f.endsWith(".DS_Store") });
  }
  return names.length;
}

function removeSkills(c: ClientDef): void {
  if (!c.skills) return;
  for (const n of ourSkills()) fs.rmSync(path.join(c.skills(), n), { recursive: true, force: true });
  removeLegacySkills(c);
}

/** Skills installed before the rename (neatbolt-*). */
function removeLegacySkills(c: ClientDef): void {
  if (!c.skills || !fs.existsSync(c.skills())) return;
  for (const d of fs.readdirSync(c.skills())) if (LEGACY_NAMES.some((n) => d.startsWith(`${n}-`))) fs.rmSync(path.join(c.skills(), d), { recursive: true, force: true });
}

// ------------------------------------------------------------------- API

function whereOf(c: ClientDef): string {
  if (c.cli) return "claude mcp (user scope)";
  return (c.json?.file ?? c.toml!.file)();
}

export function clientStatus(c: ClientDef): ClientStatus {
  const detected = (c.bins ?? []).some((b) => !!onPath(b)) || (c.dirs?.() ?? []).some((d) => fs.existsSync(d));
  const connected = c.cli ? claudeCodeConnected() : c.json ? jsonHas(c.json.file(), c.json.shape) : tomlHas(c.toml!.file());
  return { id: c.id, label: c.label, detected, connected, where: whereOf(c), note: c.note, ...(c.skills ? { skills: skillsInstalled(c) } : {}) };
}

export function listClients(): ClientStatus[] {
  return CLIENTS.map(clientStatus);
}

/** The text to add by hand, for when a file can't be edited or the agent isn't listed. */
export function manualSnippet(c: ClientDef, cmd = serverCommand()): string {
  if (c.cli) return `claude mcp add --scope user ${SERVER_NAME} -- ${[cmd.command, ...cmd.args].map(shellQuote).join(" ")}`;
  if (c.toml) return `# ${c.toml.file()}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}`;
  const shape = c.json!.shape;
  return `// ${c.json!.file()}\n${JSON.stringify({ [KEY[shape]]: { [SERVER_NAME]: entryFor(shape, cmd) } }, null, 2)}`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function connectMcp(c: ClientDef, cmd: ServerCommand): ConnectResult {
  try {
    if (c.cli) {
      if (!onPath("claude")) return { id: c.id, ok: false, message: `the claude command isn't on PATH. Run this yourself:\n  ${manualSnippet(c, cmd)}` };
      for (const n of [SERVER_NAME, ...LEGACY_NAMES]) claudeCli(["mcp", "remove", "--scope", "user", n]);
      const r = claudeCli(["mcp", "add", "--scope", "user", SERVER_NAME, "--", cmd.command, ...cmd.args]);
      return r.ok ? { id: c.id, ok: true, message: "registered with claude mcp (user scope)" } : { id: c.id, ok: false, message: `claude mcp add failed: ${r.out}` };
    }
    if (c.toml) {
      tomlSet(c.toml.file(), cmd);
      return { id: c.id, ok: true, message: `added to ${c.toml.file()}` };
    }
    const err = jsonSet(c.json!.file(), c.json!.shape, cmd);
    if (err) return { id: c.id, ok: false, message: `${err}. Add this yourself:\n${manualSnippet(c, cmd)}` };
    return { id: c.id, ok: true, message: `added to ${c.json!.file()}` };
  } catch (e) {
    return { id: c.id, ok: false, message: (e as Error).message };
  }
}

function disconnectMcp(c: ClientDef): ConnectResult {
  try {
    if (c.cli) {
      if (!onPath("claude")) return { id: c.id, ok: false, message: `the claude command isn't on PATH. Run: claude mcp remove --scope user ${SERVER_NAME}` };
      const r = claudeCli(["mcp", "remove", "--scope", "user", SERVER_NAME]);
      return { id: c.id, ok: r.ok || !claudeCodeConnected(), message: r.ok ? "removed from claude mcp" : r.out };
    }
    if (c.toml) {
      tomlSet(c.toml.file(), null);
      return { id: c.id, ok: true, message: `removed from ${c.toml.file()}` };
    }
    const err = jsonSet(c.json!.file(), c.json!.shape, null);
    return err ? { id: c.id, ok: false, message: err } : { id: c.id, ok: true, message: `removed from ${c.json!.file()}` };
  } catch (e) {
    return { id: c.id, ok: false, message: (e as Error).message };
  }
}

/** Registers the MCP server and, for agents that read skills, installs neatroots' skills. */
/** Claude Desktop keeps its config in memory and writes it back while it runs, dropping edits made meanwhile. */
function claudeDesktopRunning(): boolean {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" });
  return r.status === 0 && r.stdout.split("\n").some((l) => l.trim().endsWith("/Claude.app/Contents/MacOS/Claude"));
}

export function connectClient(c: ClientDef, cmd = serverCommand()): ConnectResult {
  const r = connectMcp(c, cmd);
  if (r.ok && c.id === "claude-desktop" && claudeDesktopRunning()) {
    return { ...r, message: `${r.message}. Claude Desktop is open and rewrites this file while it runs, so the entry may be lost: quit it (⌘Q), run neatroots connect claude-desktop again, then reopen it` };
  }
  if (!r.ok || !c.skills) return r;
  try {
    const n = installSkills(c);
    return n ? { ...r, message: `${r.message}; ${n} skills in ${c.skills()}` } : r;
  } catch (e) {
    return { ...r, message: `${r.message}; skills not installed: ${(e as Error).message}` };
  }
}

export function disconnectClient(c: ClientDef): ConnectResult {
  const r = disconnectMcp(c);
  if (r.ok) removeSkills(c);
  return r;
}
