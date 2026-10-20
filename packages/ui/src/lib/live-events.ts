import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { appKeys, runKeys } from "../features/runs/_services/run-keys";
import type { ChatEvent } from "./api";
import { go } from "./router";

/** Chat events streamed from the server, for an open chat to append without refetching. */
export const chatStream = new EventTarget();

/**
 * Subscribes to neatroots' event stream and refreshes the affected queries. Returns whether
 * the stream is connected and a counter that ticks when new spans arrive.
 */
export function useLiveEvents(): { connected: boolean; spanTick: number } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [spanTick, setSpanTick] = useState(0);
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let es: EventSource | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      void qc.invalidateQueries({ queryKey: runKeys.lists() });
      for (const id of pending.current) void qc.invalidateQueries({ queryKey: runKeys.detail(id) });
      pending.current.clear();
    };
    const schedule = (traceId: unknown) => {
      if (typeof traceId === "string") pending.current.add(traceId);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 300);
    };
    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(open, 2000);
      };
      const on = (name: string, fn: (d: Record<string, unknown>) => void) =>
        es!.addEventListener(name, (e) => {
          try {
            fn(JSON.parse((e as MessageEvent).data));
          } catch {
            /* ignore malformed */
          }
        });
      on("trace", (d) => {
        setSpanTick((x) => x + 1);
        schedule(d.trace_id);
      });
      for (const name of ["finding", "note", "explanation", "summary", "plan"]) on(name, (d) => schedule(d.trace_id));
      on("settings", () => {
        void qc.invalidateQueries({ queryKey: appKeys.status });
        void qc.invalidateQueries({ queryKey: appKeys.projects });
      });
      on("replay", (d) => {
        schedule(d.trace_id);
        if (typeof d.new_trace_id === "string") schedule(d.new_trace_id);
      });
      on("import", (d) => {
        void qc.invalidateQueries({ queryKey: ["imports"] });
        if (d.state !== "running") void qc.invalidateQueries({ queryKey: runKeys.lists() });
      });
      on("chat", (d) => {
        const event = d.event as ChatEvent | undefined;
        if (event) chatStream.dispatchEvent(new CustomEvent("event", { detail: { session_id: d.session_id, event } }));
        if (event?.kind === "result" || event?.kind === "error" || event?.kind === "status") void qc.invalidateQueries({ queryKey: ["chat-sessions"] });
        // The turn is over: the open chat reads its state again (it may have read "running" on the result).
        if (typeof d.state === "string") {
          void qc.invalidateQueries({ queryKey: ["chat-sessions"] });
          void qc.invalidateQueries({ queryKey: ["chat-session", d.session_id] });
        }
      });
      // A coding agent asked to show something (MCP show_in_ui).
      on("navigate", (d) => {
        if (typeof d.path === "string") go(d.path);
      });
      on("activity", (d) => {
        if (String(d.kind ?? "").startsWith("push")) void qc.invalidateQueries({ queryKey: appKeys.pushes });
        schedule(d.trace_id);
      });
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(timer.current);
      es?.close();
    };
  }, [qc]);
  return { connected, spanTick };
}
