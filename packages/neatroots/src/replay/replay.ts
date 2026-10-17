import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Roots } from "../core.js";
import { loadTrace, runGoal } from "../engine/trace.js";
import { toBatches, type SpanNode } from "../ingest/build.js";
import type { ChatMessage } from "../models/llm.js";
import type { Plain } from "../otlp/types.js";
import { attr } from "../otlp/types.js";
import { isSystemRole, maybeJson, preview } from "../semantics/view.js";
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
  /**
   * LLM replay: send the call's recorded tool definitions (default) so the model can answer with
   * a tool call; false replays in text-only mode.
   */
  tools?: boolean;
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

function text(v: Plain | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.length ? v : undefined;
  return String(v);
}

/** Recorded tool calls on a message: an array, a JSON string, or the flattened per-index shape. */
function callsOf(msg: Record<string, Plain>): Record<string, Plain>[] {
  const raw = maybeJson(msg.tool_calls);
  if (Array.isArray(raw)) return raw.filter((c): c is Record<string, Plain> => !!c && typeof c === "object" && !Array.isArray(c));
  if (raw && typeof raw === "object") return Object.values(raw).filter((c): c is Record<string, Plain> => !!c && typeof c === "object" && !Array.isArray(c));
  return [];
}

/**
 * Chat messages as neatroots' LLM client takes them. By default tool turns become plain text;
 * with structuredToolTurns they keep their shape (assistant tool_calls and tool results carrying
 * the id they answer), which is what a replay sends when it offers the recorded tools again.
 */
export function toChat(messages: Plain | undefined, opts: { structuredToolTurns?: boolean } = {}): ChatMessage[] {
  if (!Array.isArray(messages)) return typeof messages === "string" ? [{ role: "user", content: messages }] : [];
  const out: ChatMessage[] = [];
  // Ids of tool calls whose results have not been seen yet, for results recorded without one.
  const pending: string[] = [];
  let generated = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const msg = m as Record<string, Plain>;
    const role = String(msg.role ?? "user");
    const content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);
    const calls = callsOf(msg);
    if (role === "tool" || role === "function") {
      if (!opts.structuredToolTurns) {
        out.push({ role: "user", content: `[tool result${msg.name ? ` from ${msg.name}` : ""}]\n${content}` });
        continue;
      }
      const id = text(msg.tool_call_id) ?? pending.shift() ?? `replay_tool_${generated++}`;
      out.push({ role: "tool", content, tool_call_id: id, ...(text(msg.name) ? { name: text(msg.name) } : {}) });
      continue;
    }
    if (calls.length) {
      if (!opts.structuredToolTurns) {
        const named = calls.map((c) => `${c.name ?? "tool"}(${JSON.stringify(c.arguments ?? {})})`).join(", ");
        out.push({ role: "assistant", content: `${content}${content ? "\n" : ""}[called ${named}]` });
        continue;
      }
      const mapped = calls.map((c) => {
        const id = text(c.id) ?? `replay_tool_${generated++}`;
        pending.push(id);
        return { id, name: text(c.name) ?? "tool", arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) };
      });
      out.push({ role: "assistant", content, tool_calls: mapped });
      continue;
    }
    out.push({ role: isSystemRole(role) ? "system" : role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

export class Replays {
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
    this.save(r);
    return r;
  }

  private finish(r: Replay, patch: Partial<Replay>): Replay {
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
    // The recorded tools go back with the call unless the caller asked for a text-only replay.
    const tools = overrides.tools === false ? [] : (span.toolDefinitions ?? []);
    const messages: ChatMessage[] = overrides.messages?.length ? toChat(overrides.messages as Plain) : toChat(span.input, { structuredToolTurns: tools.length > 0 });
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
      const res = await this.roots.llm.chat(messages, {
        model: overrides.model,
        maxTokens: 2048,
        temperature: 0.2,
        priority: "high",
        timeoutSec: 180,
        ...(tools.length
          ? {
              tools: tools.map((d) => ({
                name: d.name,
                description: d.description,
                parameters: d.parameters && typeof d.parameters === "object" && !Array.isArray(d.parameters) ? (d.parameters as Record<string, unknown>) : undefined,
              })),
            }
          : {}),
      });
      const endMs = Date.now();
      const newTrace = crypto.randomBytes(16).toString("hex");
      const calls = res.toolCalls ?? [];
      const output = calls.length
        ? [{ role: "assistant", content: res.text, tool_calls: calls.map((c) => ({ id: c.id ?? null, name: c.name, arguments: maybeJson(c.arguments) ?? c.arguments })) }]
        : [{ role: "assistant", content: res.text }];
      // A tool-call answer has no text; render it so the replay's preview and root output say something.
      const answer = res.text.trim() || calls.map((c) => `${c.name}(${c.arguments})`).join(", ");
      const replayAttrs = { "neatroots.replay.id": r.id, "neatroots.replay.of_trace": traceId, "neatroots.replay.of_span": span.id };
      // Record the offered tools and any tool call on the LLM span, as a recorded call carries them.
      const toolAttrs: Record<string, unknown> = {};
      calls.forEach((c, i) => {
        if (c.id) toolAttrs[`neatlogs.llm.tool_calls.${i}.id`] = c.id;
        toolAttrs[`neatlogs.llm.tool_calls.${i}.name`] = c.name;
        toolAttrs[`neatlogs.llm.tool_calls.${i}.arguments`] = c.arguments;
      });
      if (tools.length) {
        tools.forEach((d, i) => {
          toolAttrs[`neatlogs.llm.tools.${i}.name`] = d.name;
          if (d.description) toolAttrs[`neatlogs.llm.tools.${i}.description`] = d.description;
          if (d.parameters !== undefined) toolAttrs[`neatlogs.llm.tools.${i}.input_schema`] = typeof d.parameters === "string" ? d.parameters : JSON.stringify(d.parameters);
        });
      }
      const nodes: SpanNode[] = [
        { traceId: newTrace, spanId: `${newTrace}:root`, name: `replay: ${span.name}`, kind: "workflow", start: startMs, end: endMs, input: messages.filter((m) => m.role === "user").at(-1)?.content, output: answer, attributes: replayAttrs },
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
          attributes: { ...replayAttrs, ...toolAttrs },
        },
      ];
      this.roots.ingest(toBatches(nodes, { project: t.run?.project ?? "replay", source: "replay" }));
      return this.finish(r, { state: "succeeded", new_trace_id: newTrace, output_preview: preview(answer, 400) });
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
    const started = Date.now();
    let linked: string | null = null;
    // The run it produces carries neatroots.replay.id as a resource attribute (via
    // OTEL_RESOURCE_ATTRIBUTES); failing that, it's the project's first run after the start.
    const off = this.roots.bus.on("trace", (u) => {
      if (linked || !u.runCreated) return;
      const res = u.spans[0] ? this.roots.store.getOtlpSpan(u.traceId, u.spans[0].row.span_id)?.resource : undefined;
      if (res && attr(res.attributes, "neatroots.replay.id") === r.id) linked = u.traceId;
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
      // Spans arrive on the SDK's flush interval; give the run a moment to land.
      for (let i = 0; i < 20 && !linked; i++) {
        await new Promise((res) => setTimeout(res, 500));
        if (!linked) {
          const fresh = this.roots.store.listRuns({ project, sinceMs: started - 500, limit: 5 }).filter((x) => x.trace_id !== r.trace_id && !this.originOf(x.trace_id));
          if (fresh.length && i >= 4) linked = fresh[fresh.length - 1].trace_id;
        }
      }
      if (!linked) return this.finish(r, { state: "failed", error: "the agent ran, but no new run reached neatroots. Is it pointed at neatroots (NEATLOGS_ENDPOINT)?", log_tail: tail || null });
      const run = this.roots.store.getRun(linked);
      return this.finish(r, { state: "succeeded", new_trace_id: linked, output_preview: run?.output_preview ?? null, log_tail: tail || null });
    } finally {
      off();
    }
  }
}
