import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Roots } from "../core.js";
import { loadTrace, runGoal } from "../engine/trace.js";
import { toBatches, type SpanNode } from "../ingest/build.js";
import type { ChatMessage } from "../models/llm.js";
import type { Plain } from "../otlp/types.js";
import { attr } from "../otlp/types.js";
import { isSystemRole, preview } from "../semantics/view.js";
import { log } from "../util/log.js";

// Replays. An LLM-call replay re-sends one LLM span's messages (as edited) to the configured LLM
// and stores the answer as a new run; no agent needed. A run replay re-runs the whole agent with
// overrides, through the command or HTTP endpoint registered for its project, and links the run it
// produces. Either way the new run goes through checks like any other, so "did the fix work?" is
// answered by its findings.

export interface ReplayOverrides {
  /** LLM replay: the messages to send instead of the span's. */
  messages?: { role: string; content: string }[];
  /** LLM replay: change one recorded message (matched by its text) and keep the rest. */
  edit?: { from: string; to: string };
  /** Run replay: the user input to run the agent with. */
  input?: string;
  model?: string;
  system?: string;
}

export interface Replay {
  id: string;
  trace_id: string;
  span_id: string | null;
  kind: "llm" | "run";
  via: "llm" | "command" | "http";
  overrides: ReplayOverrides;
  state: "running" | "succeeded" | "failed";
  new_trace_id: string | null;
  output_preview: string | null;
  error: string | null;
  log_tail: string | null;
  created_ms: number;
  finished_ms: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS replays (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  kind TEXT NOT NULL,
  via TEXT NOT NULL,
  overrides TEXT NOT NULL,
  state TEXT NOT NULL,
  new_trace_id TEXT,
  output_preview TEXT,
  error TEXT,
  log_tail TEXT,
  created_ms INTEGER NOT NULL,
  finished_ms INTEGER
);
CREATE INDEX IF NOT EXISTS replays_trace ON replays (trace_id);
CREATE INDEX IF NOT EXISTS replays_new ON replays (new_trace_id);
`;

type Row = Omit<Replay, "overrides"> & { overrides: string };

/** Chat messages as neatroots' LLM client takes them; tool turns become plain text. */
export function toChat(messages: Plain | undefined): ChatMessage[] {
  if (!Array.isArray(messages)) return typeof messages === "string" ? [{ role: "user", content: messages }] : [];
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const msg = m as Record<string, Plain>;
    const role = String(msg.role ?? "user");
    let content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const calls = (msg.tool_calls as Record<string, Plain>[]).map((c) => `${c.name ?? "tool"}(${JSON.stringify(c.arguments ?? {})})`).join(", ");
      content = `${content}${content ? "\n" : ""}[called ${calls}]`;
    }
    if (role === "tool" || role === "function") out.push({ role: "user", content: `[tool result${msg.name ? ` from ${msg.name}` : ""}]\n${content}` });
    else out.push({ role: isSystemRole(role) ? "system" : role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

export class Replays {
  // Overlap is remembered for the entire replay, even if its neighbour finishes first.
  private readonly replayWindows = new Map<string, { overlapped: boolean }>();
  constructor(private readonly roots: Roots) {
    roots.store.db.exec(SCHEMA);
    // A replay runs in this process (a child command or an HTTP call); it cannot
    // survive a restart. Mark any left in "running" as failed so they don't show
    // "running" forever. (Checks resume after a restart; a replay can't.)
    roots.store.db
      .prepare("UPDATE replays SET state = 'failed', error = ?, finished_ms = ? WHERE state = 'running'")
      .run("interrupted by a restart", Date.now());
  }

  private save(r: Replay): void {
    this.roots.store.db
      .prepare(
        `INSERT INTO replays (id, trace_id, span_id, kind, via, overrides, state, new_trace_id, output_preview, error, log_tail, created_ms, finished_ms)
         VALUES (@id, @trace_id, @span_id, @kind, @via, @overrides, @state, @new_trace_id, @output_preview, @error, @log_tail, @created_ms, @finished_ms)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, new_trace_id = excluded.new_trace_id, output_preview = excluded.output_preview,
           error = excluded.error, log_tail = excluded.log_tail, finished_ms = excluded.finished_ms`,
      )
      .run({ ...r, overrides: JSON.stringify(r.overrides) });
    this.roots.bus.emit("replay", { id: r.id, state: r.state, trace_id: r.trace_id, new_trace_id: r.new_trace_id, error: r.error });
  }

  private parse(row: Row): Replay {
    return { ...row, overrides: JSON.parse(row.overrides) as ReplayOverrides };
  }

  /** Replays made from this run, newest first. */
  forRun(traceId: string): Replay[] {
    return (this.roots.store.db.prepare("SELECT * FROM replays WHERE trace_id = ? ORDER BY created_ms DESC LIMIT 50").all(traceId) as Row[]).map((r) => this.parse(r));
  }

  /** The replay that produced this run, if it is one. */
  originOf(traceId: string): Replay | undefined {
    const row = this.roots.store.db.prepare("SELECT * FROM replays WHERE new_trace_id = ?").get(traceId) as Row | undefined;
    return row ? this.parse(row) : undefined;
  }

  get(id: string): Replay | undefined {
    const row = this.roots.store.db.prepare("SELECT * FROM replays WHERE id = ?").get(id) as Row | undefined;
    return row ? this.parse(row) : undefined;
  }

  /** How this project's agent can be re-run: a command, an HTTP endpoint, or neither. */
  target(project: string | null | undefined): { command?: string; cwd?: string; url?: string } | undefined {
    return project ? this.roots.config.rerun[project] : undefined;
  }

  private create(traceId: string, spanId: string | null, kind: Replay["kind"], via: Replay["via"], overrides: ReplayOverrides): Replay {
    const r: Replay = {
      id: `rp_${crypto.randomBytes(6).toString("hex")}`,
      trace_id: traceId,
      span_id: spanId,
      kind,
      via,
      overrides,
      state: "running",
      new_trace_id: null,
      output_preview: null,
      error: null,
      log_tail: null,
      created_ms: Date.now(),
      finished_ms: null,
    };
    for (const window of this.replayWindows.values()) window.overlapped = true;
    this.replayWindows.set(r.id, { overlapped: this.replayWindows.size > 0 });
    this.save(r);
    return r;
  }

  private finish(r: Replay, patch: Partial<Replay>): Replay {
    this.replayWindows.delete(r.id);
    Object.assign(r, patch, { finished_ms: Date.now() });
    this.save(r);
    return r;
  }

  /** Re-sends one LLM span's messages (or edited ones) and stores the answer as a new run. */
  async replayLlm(traceId: string, spanId: string, overrides: ReplayOverrides = {}): Promise<Replay> {
    const t = loadTrace(this.roots.store, traceId);
    const span = t.spans.find((s) => s.id === spanId || s.id.startsWith(spanId));
    if (!span) throw new Error("span not found");
    if (span.kind !== "LLM") throw new Error("only LLM spans can be replayed on their own; replay the whole run instead");
    const messages: ChatMessage[] = overrides.messages?.length ? toChat(overrides.messages as Plain) : toChat(span.input);
    if (overrides.edit) {
      const { from, to } = overrides.edit;
      const i = messages.findIndex((m) => m.content === from) >= 0 ? messages.findIndex((m) => m.content === from) : messages.findIndex((m) => m.content.trim() === from.trim());
      if (i < 0) throw new Error("that message isn't in this LLM call");
      messages[i] = { ...messages[i], content: to };
      // Later turns followed from the old message; the fork ends at the edited one.
      messages.splice(i + 1);
    }
    if (overrides.system) {
      const i = messages.findIndex((m) => m.role === "system");
      if (i >= 0) messages[i] = { role: "system", content: overrides.system };
      else messages.unshift({ role: "system", content: overrides.system });
    }
    if (!messages.length) throw new Error("this LLM span has no recorded messages to replay");
    const { edit: _edit, ...rest } = overrides;
    const r = this.create(traceId, span.id, "llm", "llm", { ...rest, messages: messages.map((m) => ({ role: m.role, content: m.content })) });
    try {
      const startMs = Date.now();
      const res = await this.roots.llm.chat(messages, { model: overrides.model, maxTokens: 2048, temperature: 0.2, priority: "high", timeoutSec: 180 });
      const endMs = Date.now();
      const newTrace = crypto.randomBytes(16).toString("hex");
      const output = [{ role: "assistant", content: res.text }];
      const replayAttrs = { "neatroots.replay.id": r.id, "neatroots.replay.of_trace": traceId, "neatroots.replay.of_span": span.id };
      const nodes: SpanNode[] = [
        { traceId: newTrace, spanId: `${newTrace}:root`, name: `replay: ${span.name}`, kind: "workflow", start: startMs, end: endMs, input: messages.filter((m) => m.role === "user").at(-1)?.content, output: res.text, attributes: replayAttrs },
        {
          traceId: newTrace,
          spanId: `${newTrace}:llm`,
          parentSpanId: `${newTrace}:root`,
          name: span.name,
          kind: "llm",
          start: startMs,
          end: endMs,
          input: messages,
          output,
          model: res.model,
          provider: res.where ?? null,
          promptTokens: res.usage?.prompt_tokens ?? null,
          completionTokens: res.usage?.completion_tokens ?? null,
          attributes: replayAttrs,
        },
      ];
      this.roots.ingest(toBatches(nodes, { project: t.run?.project ?? "replay", source: "replay" }));
      return this.finish(r, { state: "succeeded", new_trace_id: newTrace, output_preview: preview(res.text, 400) });
    } catch (err) {
      return this.finish(r, { state: "failed", error: (err as Error).message });
    }
  }

  /** Re-runs the whole agent with overrides. Returns at once; the replay finishes in the background. */
  startRun(traceId: string, overrides: ReplayOverrides = {}): { replay: Replay; done: Promise<Replay> } {
    const t = loadTrace(this.roots.store, traceId);
    if (!t.run) throw new Error("run not found");
    const project = t.run.project;
    const target = this.target(project);
    if (!target?.command && !target?.url) {
      throw new Error(`no way to re-run ${project ?? "this agent"} yet. Register one: neatroots rerun add ${project ?? "<project>"} "<command>" (or --url for an HTTP replay endpoint)`);
    }
    const input = overrides.input ?? runGoal(t).user ?? runGoal(t).rootInput ?? "";
    const r = this.create(traceId, null, "run", target.url ? "http" : "command", { ...overrides, input });
    const done = this.runAgent(r, project ?? "", target, input, overrides).catch((err) => this.finish(r, { state: "failed", error: (err as Error).message }));
    return { replay: r, done };
  }

  private async runAgent(r: Replay, project: string, target: { command?: string; cwd?: string; url?: string }, input: string, o: ReplayOverrides): Promise<Replay> {
    let linked: string | null = null;
    const appeared = new Set<string>();
    const candidates = new Set<string>();
    const seenIds = new Map<string, Set<Plain>>();
    const window = this.replayWindows.get(r.id)!;
    // Only inspect runs first seen during this replay. A root may arrive after its children.
    const off = this.roots.bus.on("trace", (u) => {
      if (linked) return;
      if (u.runCreated) appeared.add(u.traceId);
      if (!appeared.has(u.traceId)) return;
      const run = this.roots.store.getRun(u.traceId);
      const root = run?.root_span_id ? this.roots.store.getOtlpSpan(u.traceId, run.root_span_id) : undefined;
      const ids = u.spans.map((s) => this.roots.store.getOtlpSpan(u.traceId, s.row.span_id))
        .map((s) => attr(s?.resource.attributes, "neatroots.replay.id"));
      ids.push(attr(root?.span.attributes, "neatroots.replay.id"));
      const explicit = seenIds.get(u.traceId) ?? new Set<Plain>();
      for (const id of ids) if (id !== undefined) explicit.add(id);
      seenIds.set(u.traceId, explicit);
      if (explicit.size) {
        candidates.delete(u.traceId);
        if (explicit.size === 1 && explicit.has(r.id)) linked = u.traceId;
      } else if (run?.project === project) candidates.add(u.traceId);
    });
    try {
      let tail = "";
      if (target.url) {
        const res = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ replay_id: r.id, replay_of: r.trace_id, input, model: o.model ?? null, system_prompt: o.system ?? null }),
          signal: AbortSignal.timeout(15 * 60_000),
        });
        tail = (await res.text()).slice(-3000);
        if (!res.ok) throw new Error(`replay endpoint answered ${res.status}: ${tail.slice(0, 300)}`);
      } else {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NEATLOGS_ENDPOINT: `http://localhost:${this.roots.config.port}`,
          NEATLOGS_API_KEY: process.env.NEATLOGS_API_KEY ?? "neatroots-local",
          NEATROOTS_REPLAY_ID: r.id,
          NEATROOTS_REPLAY_OF: r.trace_id,
          NEATROOTS_REPLAY_INPUT: input,
          OTEL_RESOURCE_ATTRIBUTES: [process.env.OTEL_RESOURCE_ATTRIBUTES, `neatroots.replay.id=${r.id}`, `neatroots.replay.of=${r.trace_id}`].filter(Boolean).join(","),
        };
        if (o.model) env.NEATROOTS_REPLAY_MODEL = o.model;
        if (o.system) env.NEATROOTS_REPLAY_SYSTEM_PROMPT = o.system;
        const { code, error } = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
          const child = spawn(target.command!, { shell: true, cwd: target.cwd, env });
          const keep = (b: Buffer) => {
            tail = (tail + b.toString()).slice(-6000);
          };
          child.stdout.on("data", keep);
          child.stderr.on("data", keep);
          const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
          child.on("close", (c) => {
            clearTimeout(timer);
            resolve({ code: c });
          });
          // A command that can't start (its folder was deleted, say) emits "error" instead of "close";
          // unhandled, that event would stop the whole neatroots process.
          child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: null, error: e });
          });
        });
        if (error) {
          throw new Error(
            target.cwd && !fs.existsSync(target.cwd)
              ? `the rerun folder ${target.cwd} doesn't exist. Register it again: neatroots rerun add ${project} "<command>" --cwd <dir>`
              : `couldn't start the rerun command: ${error.message}`,
          );
        }
        if (code !== 0) log.info(`replay ${r.id}: the agent exited with ${code}`);
      }
      // Prefer an explicit ID throughout the SDK flush window, even after a candidate appears.
      for (let i = 0; i < 20 && !linked; i++) {
        await new Promise((res) => setTimeout(res, 500));
      }
      if (!linked && !window.overlapped && candidates.size === 1) linked = candidates.values().next().value!;
      if (!linked) return this.finish(r, { state: "failed", error: "the agent ran, but no new run reached neatroots. Is it pointed at neatroots (NEATLOGS_ENDPOINT)?", log_tail: tail || null });
      const run = this.roots.store.getRun(linked);
      return this.finish(r, { state: "succeeded", new_trace_id: linked, output_preview: run?.output_preview ?? null, log_tail: tail || null });
    } finally {
      off();
    }
  }
}
