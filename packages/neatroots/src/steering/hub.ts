import type { Roots } from "../core.js";
import { projectSettings, type SteeringMode } from "../config.js";
import type { Note } from "../types.js";
import { isRule, type Check } from "../checks/types.js";
import { log } from "../util/log.js";

export interface SteerEvent {
  event: "note" | "retract" | "mode" | "ping";
  data: Record<string, unknown>;
}

type Subscriber = (e: SteerEvent) => void;

/**
 * Steering gets a finding back into a running agent as a note on its next LLM call.
 * The hook in the agent's process listens on an SSE stream and claims at most one
 * note per LLM call; a claim marks the note delivered so it is never sent twice.
 */
export class SteeringHub {
  private subscribers = new Set<Subscriber>();
  /** Set by the engine: resolves when no checks are pending for a trace. */
  idleWaiter?: (traceId: string, timeoutMs: number) => Promise<boolean>;

  constructor(private readonly roots: Roots) {}

  /**
   * The user's halt rules among `checks` that can't reach an agent, because steering is off for
   * every project they apply to (off sends nothing, halts included).
   */
  inactiveHalts(checks: Check[]): string[] {
    const projects = Object.keys(this.roots.config.projects);
    return checks
      .filter((c) => c.enabled !== false && isRule(c) && c.action === "halt")
      .filter((c) => {
        const scope = c.applies_to?.project;
        const where = scope === undefined ? projects : Array.isArray(scope) ? scope : [scope];
        return !where.some((p) => this.mode(p) !== "off");
      })
      .map((c) => c.id);
  }

  /** Logs the halt rules that won't stop agents until steering is on. */
  warnInactiveHalts(checks: Check[]): void {
    const ids = this.inactiveHalts(checks);
    if (ids.length) log.warn(`halt rule${ids.length > 1 ? "s" : ""} ${ids.join(", ")} won't stop agents: steering is off where ${ids.length > 1 ? "they apply" : "it applies"}, and off sends nothing. Turn it on for the project: neatroots steering advisory --project <name>`);
  }

  /** The steering mode for a project; off unless the user enabled it. */
  mode(project: string | null | undefined): SteeringMode {
    if (!this.roots.config.steering.enabled) return "off";
    if (!project) return "off";
    return projectSettings(this.roots.config, project).steering;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get listeners(): number {
    return this.subscribers.size;
  }

  private broadcast(e: SteerEvent): void {
    for (const s of this.subscribers) {
      try {
        s(e);
      } catch (err) {
        log.debug("steer subscriber failed", err);
      }
    }
  }

  deliveredCount(traceId: string): number {
    return this.roots.store.notesForTrace(traceId).filter((n) => n.status === "delivered").length;
  }

  pendingCount(traceId: string): number {
    return this.roots.store.notesForTrace(traceId, "pending").filter((n) => n.kind !== "halt").length;
  }

  /** Queues a note for a run. Returns undefined when steering is off or the run's limit is reached. */
  push(input: { traceId: string; findingId: string | null; kind: Note["kind"]; text: string; checks?: Note["checks"] }): Note | undefined {
    const run = this.roots.store.getRun(input.traceId);
    if (!run || run.status !== "running") return undefined;
    // Off means nothing is sent (docs/steering.md), a halt from your own rule included.
    if (this.mode(run.project) === "off") return undefined;
    const limit = this.roots.config.steering.maxNotesPerRun;
    if (input.kind !== "halt" && this.deliveredCount(input.traceId) + this.pendingCount(input.traceId) >= limit) return undefined;
    const note = this.roots.store.insertNote({
      trace_id: input.traceId,
      finding_id: input.findingId,
      kind: input.kind,
      text: input.text,
      status: "pending",
      checks: input.checks ?? null,
    });
    this.roots.bus.emit("note", note);
    this.broadcast({ event: "note", data: { id: note.id, trace_id: note.trace_id, kind: note.kind, finding_id: note.finding_id, project: run.project } });
    return note;
  }

  /**
   * Replaces a still-pending note (normally the template) with a better one. If the old
   * note already reached the agent, the replacement is kept for the record but not sent.
   */
  replace(oldId: string, text: string, checks: Note["checks"]): Note | undefined {
    const old = this.roots.store.getNote(oldId);
    if (!old) return undefined;
    const ended = this.roots.store.getRun(old.trace_id)?.status !== "running";
    if (old.status !== "pending" || ended) {
      return this.roots.store.insertNote({ trace_id: old.trace_id, finding_id: old.finding_id, kind: "llm", text, status: "expired", checks });
    }
    const next = this.roots.store.insertNote({ trace_id: old.trace_id, finding_id: old.finding_id, kind: "llm", text, status: "pending", checks });
    this.roots.store.updateNote(oldId, { status: "superseded", replaced_by: next.id });
    this.roots.bus.emit("note", { ...old, status: "superseded", replaced_by: next.id });
    this.roots.bus.emit("note", next);
    this.broadcast({ event: "retract", data: { id: oldId, trace_id: old.trace_id, replaced_by: next.id } });
    this.broadcast({ event: "note", data: { id: next.id, trace_id: next.trace_id, kind: next.kind, finding_id: next.finding_id } });
    return next;
  }

  /**
   * Withdraws pending notes for a finding that resolved or was dismissed. `keepHalts` leaves
   * halt notes queued: a halt still applies when the condition that raised it has passed.
   */
  withdraw(findingId: string, opts: { keepHalts?: boolean } = {}): void {
    const f = this.roots.store.getFinding(findingId);
    if (!f) return;
    for (const n of this.roots.store.notesForTrace(f.trace_id, "pending")) {
      if (n.finding_id !== findingId) continue;
      if (opts.keepHalts && n.kind === "halt") continue;
      this.roots.store.updateNote(n.id, { status: "expired" });
      this.roots.bus.emit("note", { ...n, status: "expired" });
      this.broadcast({ event: "retract", data: { id: n.id, trace_id: n.trace_id } });
    }
  }

  /**
   * Called by the hook right before an LLM call. Returns at most one note and marks it
   * delivered. A halt note always wins; an LLM-written note wins over a template.
   */
  claim(traceId: string, spanId?: string | null): Note | undefined {
    let pending = this.roots.store.notesForTrace(traceId, "pending");
    if (!pending.length) return undefined;
    // Steering turned off after a note was queued: nothing is delivered, a halt included.
    const run = this.roots.store.getRun(traceId);
    if (this.mode(run?.project) === "off") pending = [];
    if (!pending.length) return undefined;
    const rank = (n: Note) => (n.kind === "halt" ? 0 : n.kind === "llm" ? 1 : 2);
    const pick = [...pending].sort((a, b) => rank(a) - rank(b) || a.created_ms - b.created_ms)[0];
    if (pick.kind !== "halt" && this.deliveredCount(traceId) >= this.roots.config.steering.maxNotesPerRun) {
      for (const n of pending) {
        if (n.kind !== "halt") {
          this.roots.store.updateNote(n.id, { status: "expired" });
          this.roots.bus.emit("note", { ...n, status: "expired" });
          this.broadcast({ event: "retract", data: { id: n.id, trace_id: n.trace_id } });
        }
      }
      return undefined;
    }
    this.roots.store.updateNote(pick.id, { status: "delivered", delivered_ms: Date.now(), delivered_span_id: spanId ?? null });
    const delivered = this.roots.store.getNote(pick.id)!;
    this.roots.bus.emit("note", delivered);
    if (pick.finding_id) {
      const f = this.roots.store.getFinding(pick.finding_id);
      if (f && f.status === "raised") {
        const next = this.roots.store.updateFinding(f.id, { status: "active" });
        if (next) this.roots.bus.emit("finding", next);
      }
    }
    return delivered;
  }

  /** Gate mode: wait (bounded) for checks still running on this run, then claim. */
  async gate(traceId: string, waitMs: number, spanId?: string | null): Promise<Note | undefined> {
    const wait = Math.min(Math.max(0, waitMs), 2000);
    if (this.idleWaiter && wait > 0) await this.idleWaiter(traceId, wait);
    return this.claim(traceId, spanId);
  }

  setMode(project: string, mode: SteeringMode): void {
    this.roots.config.projects[project] = { ...(this.roots.config.projects[project] ?? {}), steering: mode };
    this.broadcast({ event: "mode", data: { project, mode } });
    this.roots.bus.emit("settings", { project });
  }

  ping(): void {
    this.broadcast({ event: "ping", data: { t: Date.now() } });
  }
}
