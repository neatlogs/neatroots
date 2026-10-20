import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, del, post, type CheckRow } from "../../../lib/api";
import { appKeys } from "../../runs/_services/run-keys";

export interface ChecksResponse {
  checks: CheckRow[];
  errors: { path: string; id?: string; message: string }[];
  user_dir: string;
  project_dirs: string[];
}

export interface PreviewResult {
  second_look?: false;
  evaluation_mode?: "deterministic_rule" | "question_without_second_look";
  selection?: { candidate_limit: number; candidate_count: number; selected_count: number; window_full: boolean };
  filtered_results?: { trace_id: string; root_name: string | null; status: "filtered"; reason: string; evaluation?: undefined }[];
  checked: number;
  total: number;
  hits: { trace_id: string; probability: number | null; root_name: string | null }[];
  hit_rate: number | null;
  skipped: Record<string, number>;
  errors: Record<string, number>;
  results: {
    trace_id: string;
    root_name: string | null;
    status: "hit" | "clear" | "skipped" | "error";
    reason?: string;
    evaluation?: { targets_available: number; targets_considered: number; targets_attempted: number; targets_evaluated: number; complete: boolean; target_limit: number; stop_reason?: string };
  }[];
  truncated: boolean;
  /** What the check can't see (e.g. a question about the answer that only looks at tool calls). */
  warnings?: string[];
}

export function useChecks() {
  return useQuery({ queryKey: appKeys.checks, queryFn: () => api<ChecksResponse>("/api/checks") });
}

export function useCheckActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: appKeys.checks });
  return {
    toggle: useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => post(`/api/checks/${v.id}/enabled`, { enabled: v.enabled }), onSettled: refresh }),
    remove: useMutation({ mutationFn: (id: string) => del(`/api/checks/${id}`), onSettled: refresh }),
    // Both wait on the model; a signal lets the person cancel, which also frees its place in the queue.
    draft: useMutation({ mutationFn: (v: { concern: string; signal?: AbortSignal }) => api<{ yaml: string; warnings?: string[] }>("/api/checks/draft", { method: "POST", json: { concern: v.concern }, signal: v.signal }) }),
    preview: useMutation({ mutationFn: (v: { yaml: string; signal?: AbortSignal }) => api<PreviewResult>("/api/checks/preview", { method: "POST", json: { yaml: v.yaml, limit: 50 }, signal: v.signal }) }),
    save: useMutation({ mutationFn: (yaml: string) => post<{ id: string; path: string; warnings?: string[] }>("/api/checks", { yaml }), onSettled: refresh }),
  };
}
