import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Roots } from "../core.js";
import { findClient, clientStatus, listClients } from "../mcp/clients.js";
import { log } from "../util/log.js";

// Claude Code and Codex inside the app. Each turn runs the agent's own CLI headless in the
// user's project folder (claude -p --output-format stream-json; codex exec --json), resuming
// the same agent session, with neatroots' MCP server attached. Events are normalised, stored and
// streamed to the app. Read-only unless the user allows edits or commands for the session.

export type ChatAgent = "claude" | "codex";

export interface ChatEvent {
  seq: number;
  at: number;
  kind: "user" | "text" | "tool" | "tool_result" | "status" | "result" | "error";
  text?: string;
  tool?: { id: string; name: string; input?: unknown; output?: string; is_error?: boolean };
  meta?: Record<string, unknown>;
}

export interface ChatSession {
  id: string;
  agent: ChatAgent;
  cwd: string;
  title: string;
  trace_id: string | null;
  allow_edits: boolean;
  allow_commands: boolean;
  agent_session_id: string | null;
  state: "idle" | "running" | "error";
  created_ms: number;
  updated_ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, trace_id TEXT,
  allow_edits INTEGER NOT NULL DEFAULT 0, allow_commands INTEGER NOT NULL DEFAULT 0, agent_session_id TEXT,
  state TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (session_id, seq));
`;

const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "TodoWrite", "mcp__neatroots__*", "mcp__neatroots_app__*"];
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
/** neatroots' MCP rerun runs the project's registered agent command, so it counts as a command. */
const RERUN_TOOLS = ["mcp__neatroots__rerun", "mcp__neatroots_app__rerun"];

/** Where agent CLIs get installed when they aren't on the PATH neatroots was started with. */
function candidateDirs(): string[] {
  const h = os.homedir();
  const nvm = path.join(h, ".nvm", "versions", "node");
  const nvmBins = fs.existsSync(nvm) ? fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, "bin")) : [];
  return [path.join(h, ".local", "bin"), path.join(h, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(h, ".bun", "bin"), path.join(h, ".volta", "bin"), path.join(h, ".npm-global", "bin"), ...nvmBins];
}

/** CLIs that ship inside a desktop app: ChatGPT's Codex. */
const APP_BINS: Record<ChatAgent, string[]> = {
  claude: [],
  codex: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex")],
};

const isExec = (f: string) => {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** The agent's CLI: NEATROOTS_<AGENT>_BIN, the PATH, the usual install folders, then a desktop app's copy. */
export function agentBin(agent: ChatAgent): string | null {
  const override = process.env[`NEATROOTS_${agent.toUpperCase()}_BIN`];
  if (override) return isExec(override) ? override : null;
  const r = spawnSync("sh", ["-c", `command -v ${agent}`], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.trim() : "";
  if (found && isExec(found)) return found;
  for (const d of candidateDirs()) if (isExec(path.join(d, agent))) return path.join(d, agent);
  return APP_BINS[agent].find(isExec) ?? null;
}

/** How to use an agent neatroots connects but can't run inside the app. */
const ELSEWHERE: Record<string, { open?: string; run?: string }> = {
  cursor: { open: "cursor://" },
  vscode: { open: "vscode://" },
  "claude-desktop": { open: "claude://" },
  windsurf: { open: "windsurf://" },
  gemini: { run: "gemini" },
  opencode: { run: "opencode" },
  amp: { run: "amp" },
};

function version(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

const AUTH_FAILURE = /authenticat|credential|log ?in|oauth|session (has )?expired|api key|unauthori[sz]ed|\b40[13]\b/i;

/** A sign-in failure from the agent's own CLI, as what to do about it. */
export function signInHelp(agent: ChatAgent, message: string): string | null {
  if (!AUTH_FAILURE.test(message)) return null;
  const name = agent === "claude" ? "Claude Code" : "Codex";
  const how = /aws|bedrock/i.test(message)
    ? `It uses Amazon Bedrock on this machine: refresh your AWS login, check that \`${agent}\` works in a terminal, then send your message again.`
    : `Run \`${agent}\` in a terminal to sign in again, then send your message again.`;
  return `${name} couldn't sign in, so it never reached neatroots. ${how}\n\n${message.trim().slice(0, 600)}`;
}

/**
 * Signals an agent CLI and everything it started (tools, MCP servers): each turn runs in its own
 * process group, so its children don't outlive a Stop.
 */
function signalGroup(p: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (p.pid) process.kill(-p.pid, signal);
  } catch {
    try {
      p.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Whether anything in the agent's process group is still running. */
function groupAlive(p: ChildProcess): boolean {
  if (!p.pid) return false;
  try {
    process.kill(-p.pid, 0);
    return true;
  } catch {
    return p.exitCode === null && p.signalCode === null;
  }
}

/**
 * Asks the agent's group to stop, then kills whatever is left 3 s later. The deadline doesn't depend
 * on the turn still running: a tool that ignores SIGTERM can outlive the CLI that started it.
 */
function endGroup(p: ChildProcess): void {
  signalGroup(p, "SIGTERM");
  setTimeout(() => {
    if (groupAlive(p)) signalGroup(p, "SIGKILL");
  }, 3000).unref();
}

export class AgentChats {
  private readonly running = new Map<string, ChildProcess>();
  private readonly stopping = new Set<string>();

  constructor(private readonly roots: Roots) {
    roots.store.db.exec(SCHEMA);
    roots.store.db.prepare("UPDATE chat_sessions SET state = 'idle' WHERE state = 'running'").run();
  }

  /** Agents that chat inside the app (Claude Code, Codex), and where their CLI was found. */
  agents(): { id: ChatAgent; label: string; installed: boolean; version: string | null; mcp_connected: boolean; bin: string | null }[] {
    return (["claude", "codex"] as const).map((id) => {
      const bin = agentBin(id);
      const client = findClient(id === "claude" ? "claude-code" : "codex");
      return {
        id,
        label: id === "claude" ? "Claude Code" : "Codex",
        installed: !!bin,
        version: bin ? version(bin) : null,
        mcp_connected: !!client && clientStatus(client).connected,
        bin,
      };
    });
  }

  /** The other coding agents neatroots connects over MCP; they run in their own app or terminal. */
  elsewhere(): { id: string; label: string; detected: boolean; connected: boolean; open: string | null; run: string | null }[] {
    return listClients()
      .filter((c) => c.id !== "claude-code" && c.id !== "codex")
      .map((c) => ({ id: c.id, label: c.label, detected: c.detected, connected: c.connected, open: ELSEWHERE[c.id]?.open ?? null, run: ELSEWHERE[c.id]?.run ?? null }));
  }

  list(): ChatSession[] {
    return (this.roots.store.db.prepare("SELECT * FROM chat_sessions ORDER BY updated_ms DESC LIMIT 100").all() as Record<string, unknown>[]).map(this.row);
  }

  get(id: string): ChatSession | undefined {
    const r = this.roots.store.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }

  events(id: string, afterSeq = 0): ChatEvent[] {
    return (this.roots.store.db.prepare("SELECT json FROM chat_events WHERE session_id = ? AND seq > ? ORDER BY seq").all(id, afterSeq) as { json: string }[]).map((r) => JSON.parse(r.json) as ChatEvent);
  }

  private row = (r: Record<string, unknown>): ChatSession => ({ ...(r as unknown as ChatSession), allow_edits: !!r.allow_edits, allow_commands: !!r.allow_commands });

  create(opts: { agent: ChatAgent; cwd?: string; trace_id?: string | null; allow_edits?: boolean; allow_commands?: boolean; title?: string }): ChatSession {
    const cwd = opts.cwd?.trim() || (opts.trace_id ? this.roots.config.rerun[this.roots.store.getRun(opts.trace_id)?.project ?? ""]?.cwd : undefined) || os.homedir();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`no such folder: ${cwd}`);
    const now = Date.now();
    const s: ChatSession = {
      id: `chat_${crypto.randomBytes(6).toString("hex")}`,
      agent: opts.agent,
      cwd,
      title: opts.title?.trim() || (opts.trace_id ? `Run ${opts.trace_id.slice(0, 8)}` : "New chat"),
      trace_id: opts.trace_id ?? null,
      allow_edits: !!opts.allow_edits,
      allow_commands: !!opts.allow_commands,
      agent_session_id: null,
      state: "idle",
      created_ms: now,
      updated_ms: now,
    };
    this.roots.store.db
      .prepare("INSERT INTO chat_sessions VALUES (@id, @agent, @cwd, @title, @trace_id, @allow_edits, @allow_commands, @agent_session_id, @state, @created_ms, @updated_ms)")
      .run({ ...s, allow_edits: s.allow_edits ? 1 : 0, allow_commands: s.allow_commands ? 1 : 0 });
    return s;
  }

  update(id: string, patch: Partial<Pick<ChatSession, "allow_edits" | "allow_commands" | "title" | "agent_session_id" | "state">>): ChatSession {
    const s = this.get(id);
    if (!s) throw new Error("no such chat");
    const next = { ...s, ...patch, updated_ms: Date.now() };
    this.roots.store.db
      .prepare("UPDATE chat_sessions SET title = ?, allow_edits = ?, allow_commands = ?, agent_session_id = ?, state = ?, updated_ms = ? WHERE id = ?")
      .run(next.title, next.allow_edits ? 1 : 0, next.allow_commands ? 1 : 0, next.agent_session_id, next.state, next.updated_ms, id);
    return next;
  }

  remove(id: string): void {
    this.stop(id);
    this.roots.store.db.prepare("DELETE FROM chat_events WHERE session_id = ?").run(id);
    this.roots.store.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }

  stop(id: string): boolean {
    const p = this.running.get(id);
    if (!p) return false;
    this.stopping.add(id);
    endGroup(p);
    return true;
  }

  /**
   * The turn is over (the agent process closed). Its result event arrives a moment earlier, so an
   * open chat that refetched on the result can still have read "running"; this tells it to look again.
   */
  private ended(id: string, state: "idle" | "error"): void {
    if (!this.get(id)) return;
    this.update(id, { state });
    this.roots.bus.emit("chat", { session_id: id, state });
  }

  private emit(id: string, e: Omit<ChatEvent, "seq" | "at">): ChatEvent | undefined {
    if (!this.get(id)) return undefined;
    const row = this.roots.store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM chat_events WHERE session_id = ?").get(id) as { n: number };
    const ev: ChatEvent = { ...e, seq: row.n + 1, at: Date.now() };
    this.roots.store.db.prepare("INSERT INTO chat_events (session_id, seq, json) VALUES (?, ?, ?)").run(id, ev.seq, JSON.stringify(ev));
    this.roots.bus.emit("chat", { session_id: id, event: ev as unknown as Record<string, unknown> });
    return ev;
  }

  /** Sends one message; the agent's reply streams in as events. Resolves when the turn ends. */
  async send(id: string, text: string): Promise<void> {
    const s = this.get(id);
    if (!s) throw new Error("no such chat");
    if (this.running.has(id)) throw new Error("the agent is still answering; stop it or wait");
    const bin = agentBin(s.agent);
    if (!bin) throw new Error(`${s.agent === "claude" ? "Claude Code (claude)" : "Codex (codex)"} isn't installed, or neatroots can't find it. Set NEATROOTS_${s.agent.toUpperCase()}_BIN to its path.`);
    this.emit(id, { kind: "user", text });
    const first = !s.agent_session_id;
    if (first && s.title === "New chat") this.update(id, { title: text.slice(0, 60) });
    const prompt = first ? this.preamble(s) + text : text;
    this.update(id, { state: "running" });
    const { args } = s.agent === "claude" ? this.claudeArgs(s, prompt) : this.codexArgs(s, prompt);
    log.debug(`chat ${id}: ${bin} ${args.slice(0, -1).join(" ")}`);
    const child = spawn(bin, args, { cwd: s.cwd, env: { ...process.env, NEATLOGS_ENDPOINT: `http://localhost:${this.roots.config.port}` }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.running.set(id, child);
    let buf = "";
    let stderr = "";
    let sawResult = false;
    child.stdout!.on("data", (b: Buffer) => {
      if (!this.get(id)) return;
      buf += b.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if ((s.agent === "claude" ? this.onClaude(id, ev) : this.onCodex(id, ev)) === "result") sawResult = true;
        } catch {
          /* not an event line */
        }
      }
    });
    child.stderr!.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4000);
    });
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        this.running.delete(id);
        // The turn is over: anything the CLI started and left running goes with it.
        endGroup(child);
        const stopped = this.stopping.delete(id) || !!signal;
        if (stopped) this.emit(id, { kind: "status", text: "Stopped" });
        else if (code !== 0 && !sawResult) this.emit(id, { kind: "error", text: this.explainFailure(s.agent, stderr) });
        this.ended(id, code === 0 || stopped || sawResult ? "idle" : "error");
        resolve();
      };
      // Normally the output closes right after the CLI exits. A child it left running can hold the
      // output open, so the turn also ends shortly after the CLI itself exits.
      child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 1500).unref());
      child.on("close", (code, signal) => finish(code, signal));
      child.on("error", (err) => {
        if (done) return;
        done = true;
        this.running.delete(id);
        this.stopping.delete(id);
        this.emit(id, { kind: "error", text: err.message });
        this.ended(id, "error");
        resolve();
      });
    });
  }

  private preamble(s: ChatSession): string {
    const port = this.roots.config.port;
    const run = s.trace_id ? this.roots.store.getRun(s.trace_id) : undefined;
    if (s.trace_id) this.roots.focus = { trace_id: s.trace_id, span_id: null, at: Date.now() };
    const lines = [
      `You are working with neatroots, which records and checks this developer's AI agent runs at http://localhost:${port}. Its MCP tools (get_current_run, explain_run, get_run_outline, get_span, search_in_run, compare_runs, replay, rerun, create_check …) are available to you.`,
      run ? `The run in question is ${run.trace_id} (project ${run.project ?? "?"}, ${run.status}${run.open_finding_count ? `, ${run.open_finding_count} open problems` : ""}). Start from it.` : "",
      s.allow_edits ? "" : "You may read files but not edit them in this session; propose changes as diffs.",
      "",
    ];
    return lines.filter((l, i) => l || i === lines.length - 1).join("\n") + "\n";
  }

  private mcpUrl(): string {
    return `http://localhost:${this.roots.config.port}/mcp`;
  }

  private claudeArgs(s: ChatSession, prompt: string): { cmd: string; args: string[] } {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (s.agent_session_id) args.push("--resume", s.agent_session_id);
    // A neatroots entry the user connected already provides the tools; otherwise attach one for this session.
    const client = findClient("claude-code");
    if (!client || !clientStatus(client).connected) args.push("--mcp-config", JSON.stringify({ mcpServers: { neatroots_app: { type: "http", url: this.mcpUrl() } } }));
    const allowed = [...READ_TOOLS, ...(s.allow_edits ? EDIT_TOOLS : []), ...(s.allow_commands ? ["Bash"] : [])];
    args.push("--allowedTools", allowed.join(","));
    // Allowing tools isn't enough: the user's own Claude Code settings can allow more. Denying takes
    // them away, so a chat stays read-only (and doesn't rerun agents) until the user allows it.
    const denied = [...(s.allow_edits ? [] : EDIT_TOOLS), ...(s.allow_commands ? [] : ["Bash", ...RERUN_TOOLS])];
    if (denied.length) args.push("--disallowedTools", denied.join(","));
    if (s.allow_edits) args.push("--permission-mode", "acceptEdits");
    args.push("--", prompt);
    return { cmd: "claude", args };
  }

  private codexArgs(s: ChatSession, prompt: string): { cmd: string; args: string[] } {
    const mode = s.allow_edits || s.allow_commands ? "workspace-write" : "read-only";
    const args = ["exec"];
    // `codex exec resume` rejects --sandbox; every codex takes the same setting as a -c override.
    if (s.agent_session_id) args.push("resume", s.agent_session_id, "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${mode}"`);
    else args.push("--json", "--skip-git-repo-check", "--sandbox", mode);
    const client = findClient("codex");
    if (!client || !clientStatus(client).connected) args.push("-c", `mcp_servers.neatroots.url="${this.mcpUrl()}"`);
    // A message can start with "-" (a pasted list, a diff line); without `--` codex reads it as a flag.
    args.push("--", prompt);
    return { cmd: "codex", args };
  }

  /** Claude Code stream-json: system/init, assistant (text, tool_use), user (tool_result), result. */
  private onClaude(id: string, e: Record<string, unknown>): string | void {
    if (e.type === "system" && e.subtype === "init") {
      if (e.session_id) this.update(id, { agent_session_id: String(e.session_id) });
      const servers = (e.mcp_servers as { name: string; status: string }[] | undefined) ?? [];
      const nr = servers.find((m) => m.name.startsWith("neatroots"));
      this.emit(id, { kind: "status", text: `${e.model ?? "Claude"}${nr ? ` · neatroots MCP ${nr.status}` : ""}`, meta: { model: e.model } });
      return;
    }
    const msg = e.message as { content?: Record<string, unknown>[] } | undefined;
    if (e.type === "assistant" && msg?.content) {
      for (const c of msg.content) {
        if (c.type === "text" && str(c.text).trim()) {
          // A sign-in error comes again as the result, explained there; show it once.
          if (e.error && signInHelp("claude", str(c.text))) continue;
          this.emit(id, { kind: e.error ? "error" : "text", text: str(c.text) });
        }
        else if (c.type === "tool_use") this.emit(id, { kind: "tool", tool: { id: str(c.id), name: str(c.name), input: c.input } });
      }
      return;
    }
    if (e.type === "user" && msg?.content) {
      for (const c of msg.content) {
        if (c.type !== "tool_result") continue;
        const content = Array.isArray(c.content) ? (c.content as Record<string, unknown>[]).map((x) => str(x.text ?? x)).join("\n") : str(c.content);
        this.emit(id, { kind: "tool_result", tool: { id: str(c.tool_use_id), name: "", output: content.slice(0, 20_000), is_error: !!c.is_error } });
      }
      return;
    }
    if (e.type === "result") {
      if (e.session_id) this.update(id, { agent_session_id: String(e.session_id) });
      const denials = (e.permission_denials as { tool_name: string }[] | undefined) ?? [];
      const help = e.is_error ? signInHelp("claude", str(e.result)) : null;
      if (help) this.emit(id, { kind: "error", text: help });
      this.emit(id, {
        kind: "result",
        text: e.is_error && !help ? str(e.result) : undefined,
        meta: { ok: !e.is_error, cost_usd: e.total_cost_usd, duration_ms: e.duration_ms, denied: [...new Set(denials.map((d) => d.tool_name))] },
      });
      return "result";
    }
  }

  /** codex exec --json: thread.started, item.started/completed (agent_message, command_execution, file_change, mcp_tool_call …), turn.completed/failed. */
  private onCodex(id: string, e: Record<string, unknown>): string | void {
    if (e.type === "thread.started" && e.thread_id) {
      this.update(id, { agent_session_id: String(e.thread_id) });
      this.emit(id, { kind: "status", text: "Codex" });
      return;
    }
    const item = e.item as Record<string, unknown> | undefined;
    if ((e.type === "item.completed" || e.type === "item.started") && item) {
      const done = e.type === "item.completed";
      switch (item.type) {
        case "agent_message":
          if (done) this.emit(id, { kind: "text", text: str(item.text) });
          return;
        case "reasoning":
          return;
        case "command_execution":
          if (!done) this.emit(id, { kind: "tool", tool: { id: str(item.id), name: "shell", input: { command: item.command } } });
          else this.emit(id, { kind: "tool_result", tool: { id: str(item.id), name: "shell", output: str(item.aggregated_output).slice(0, 20_000), is_error: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) } });
          return;
        case "mcp_tool_call":
          if (!done) this.emit(id, { kind: "tool", tool: { id: str(item.id), name: `${str(item.server)}.${str(item.tool)}`, input: item.arguments } });
          else this.emit(id, { kind: "tool_result", tool: { id: str(item.id), name: str(item.tool), output: str(item.result ?? item.error).slice(0, 20_000), is_error: item.status === "failed" } });
          return;
        case "file_change":
          if (done) this.emit(id, { kind: "tool", tool: { id: str(item.id), name: "edit", input: item.changes } });
          return;
        case "error":
          this.emit(id, { kind: "error", text: str(item.message) });
          return;
        default:
          return;
      }
    }
    if (e.type === "turn.completed") {
      this.emit(id, { kind: "result", meta: { ok: true, usage: e.usage } });
      return "result";
    }
    if (e.type === "turn.failed" || e.type === "error") {
      const message = str((e.error as Record<string, unknown> | undefined)?.message ?? e.message);
      this.emit(id, { kind: "error", text: signInHelp("codex", message) ?? message });
      return "result";
    }
  }

  private explainFailure(agent: ChatAgent, stderr: string): string {
    const s = stderr.trim();
    return signInHelp(agent, s) ?? (s ? s.slice(-1200) : `${agent} exited without an answer`);
  }
}
