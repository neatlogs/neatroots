import { EventEmitter } from "node:events";
import { log } from "./util/log.js";
import type { TraceUpdate } from "./store/db.js";
import type { Explanation, Finding, Note } from "./types.js";

export interface RootsEvents {
  trace: TraceUpdate;
  finding: Finding;
  note: Note;
  explanation: Explanation;
  summary: { trace_id: string; text: string };
  plan: { workflow: string; plan_id: string; trace_id?: string };
  settings: { project?: string };
  activity: { trace_id?: string; kind: string; message: string };
  /** An import job's progress (ingest/importers). */
  import: { id: string; source: string; state: string; traces: number; spans: number; failed: number; last_error: string | null };
  /** One streamed event from a coding-agent chat session (agents/chat), or (state only) a turn that just ended. */
  chat: { session_id: string; event?: Record<string, unknown>; state?: "idle" | "error" };
  /** A coding agent asked the app to open something (MCP show_in_ui); path is a hash route. */
  navigate: { path: string };
  /** A replay finished or failed (replay/). */
  replay: { id: string; state: string; trace_id: string; new_trace_id?: string | null; error?: string | null };
}

export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  emit<K extends keyof RootsEvents>(event: K, payload: RootsEvents[K]): void {
    this.ee.emit(event, payload);
    this.ee.emit("*", { event, payload });
  }

  /** Logs and their recovery receipts are already committed: subscriber failure must not request a retry. */
  emitCommittedTrace(payload: TraceUpdate): void {
    const failed = () => log.warn("committed log trace notification failed; pending checks can resume on restart");
    for (const [event, data] of [["trace", payload], ["*", { event: "trace", payload }]] as const) {
      for (const listener of this.ee.listeners(event)) {
        try {
          const result: unknown = listener.call(this.ee, data);
          // Subscribers may be async even though ordinary event delivery is synchronous.
          if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(failed);
        } catch {
          failed();
        }
      }
    }
  }

  on<K extends keyof RootsEvents>(event: K, fn: (payload: RootsEvents[K]) => void): () => void {
    this.ee.on(event, fn);
    return () => this.ee.off(event, fn);
  }

  onAny(fn: (e: { event: keyof RootsEvents; payload: unknown }) => void): () => void {
    this.ee.on("*", fn);
    return () => this.ee.off("*", fn);
  }
}
