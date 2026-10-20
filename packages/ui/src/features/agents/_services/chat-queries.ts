import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, del, post, type ChatAgentInfo, type ChatEvent, type ChatSession, type OtherAgent } from "@/lib/api";
import { chatStream } from "@/lib/live-events";

export const chatKeys = { sessions: ["chat-sessions"] as const, agents: ["chat-agents"] as const, session: (id: string) => ["chat-session", id] as const };

export function useChatAgents() {
  return useQuery({ queryKey: chatKeys.agents, queryFn: () => api<{ agents: ChatAgentInfo[]; elsewhere?: OtherAgent[] }>("/api/chat/agents"), staleTime: 60_000 });
}

export function useChatSessions() {
  return useQuery({ queryKey: chatKeys.sessions, queryFn: () => api<{ sessions: ChatSession[] }>("/api/chat/sessions") });
}

/** A session and its events: fetched once, then kept current from the live stream. */
export function useChat(id: string | undefined) {
  const { data, refetch } = useQuery({
    queryKey: chatKeys.session(id ?? ""),
    queryFn: () => api<{ session: ChatSession; events: ChatEvent[] }>(`/api/chat/sessions/${id}`),
    enabled: !!id,
  });
  const [live, setLive] = useState<ChatEvent[]>([]);
  useEffect(() => {
    setLive([]);
  }, [id, data]);
  useEffect(() => {
    if (!id) return;
    const on = (e: Event) => {
      const { session_id, event } = (e as CustomEvent<{ session_id: string; event: ChatEvent }>).detail;
      if (session_id !== id || !event) return;
      setLive((cur) => (cur.some((x) => x.seq === event.seq) ? cur : [...cur, event]));
      if (event.kind === "result" || event.kind === "error") void refetch();
    };
    chatStream.addEventListener("event", on);
    return () => chatStream.removeEventListener("event", on);
  }, [id, refetch]);
  const known = new Set((data?.events ?? []).map((e) => e.seq));
  const events = [...(data?.events ?? []), ...live.filter((e) => !known.has(e.seq))].sort((a, b) => a.seq - b.seq);
  const running = data?.session.state === "running" || (live.length > 0 && !["result", "error"].includes(live[live.length - 1].kind) && live[live.length - 1].kind !== "status");
  return { session: data?.session, events, running };
}

export function useChatActions() {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: chatKeys.sessions });
    if (id) void qc.invalidateQueries({ queryKey: chatKeys.session(id) });
  };
  return {
    create: useMutation({
      mutationFn: (b: { agent: "claude" | "codex"; cwd?: string; trace_id?: string; allow_edits?: boolean; allow_commands?: boolean }) => post<ChatSession>("/api/chat/sessions", b),
      onSuccess: (s) => refresh(s.id),
      onError: (e) => toast.error(`Couldn't start the chat: ${(e as Error).message}`),
    }),
    send: useMutation({
      mutationFn: (v: { id: string; text: string }) => post(`/api/chat/sessions/${v.id}/messages`, { text: v.text }),
      onSuccess: (_d, v) => refresh(v.id),
      onError: (e) => toast.error(`Couldn't send: ${(e as Error).message}`),
    }),
    stop: useMutation({ mutationFn: (id: string) => post(`/api/chat/sessions/${id}/stop`), onSettled: (_d, _e, id) => refresh(id) }),
    update: useMutation({
      mutationFn: (v: { id: string; allow_edits?: boolean; allow_commands?: boolean }) => api(`/api/chat/sessions/${v.id}`, { method: "PATCH", json: v }),
      onSettled: (_d, _e, v) => refresh(v.id),
    }),
    remove: useMutation({ mutationFn: (id: string) => del(`/api/chat/sessions/${id}`), onSettled: () => refresh() }),
  };
}
