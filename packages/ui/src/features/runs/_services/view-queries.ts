import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type ChatItem, type Replay, type ReplayOptions, type Run } from "@/lib/api";
import { runKeys } from "./run-keys";

/** The run read as a conversation; `agent` scopes it to one sub-agent span. */
export function useRunChat(traceId: string, agent?: string) {
  return useQuery({
    queryKey: [...runKeys.detail(traceId), "chat", agent ?? ""],
    queryFn: () => api<{ root: string | null; items: ChatItem[] }>(`/api/runs/${traceId}/chat${agent ? `?agent=${agent}` : ""}`),
  });
}

/** Every run in this run's session, oldest first. */
export function useConversation(traceId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...runKeys.detail(traceId), "conversation"],
    queryFn: () => api<{ session_id: string | null; runs: Run[] }>(`/api/conversation?trace_id=${traceId}`),
    enabled,
  });
}

export function useReplayOptions(traceId: string, enabled: boolean) {
  return useQuery({ queryKey: [...runKeys.detail(traceId), "replay-options"], queryFn: () => api<ReplayOptions>(`/api/runs/${traceId}/replay-options`), enabled });
}

export type ReplayRequest = { span_id?: string; messages?: { role: string; content: string }[]; edit?: { from: string; to: string }; input?: string; model?: string; system?: string };

/** Starts a replay. LLM-call replays come back finished; run replays come back running and finish later. */
export function useReplay(traceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReplayRequest) => post<Replay>(`/api/runs/${traceId}/replay`, body),
    onSettled: () => void qc.invalidateQueries({ queryKey: runKeys.detail(traceId) }),
  });
}
