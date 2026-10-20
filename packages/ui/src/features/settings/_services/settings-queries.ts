import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, del, post, type AgentClient, type LlmInfo, type ProjectRow } from "@/lib/api";
import { appKeys } from "../../runs/_services/run-keys";

export interface ForwardRow {
  id: string;
  trace_ids: string[];
  status: string;
  error: string | null;
  created_ms: number;
  span_count: number;
  redactions: number;
}

export function useProjects() {
  return useQuery({ queryKey: appKeys.projects, queryFn: () => api<{ projects: ProjectRow[] }>("/api/projects") });
}

export function useForwards() {
  return useQuery({ queryKey: appKeys.forwards, queryFn: () => api<{ forwards: ForwardRow[] }>("/api/forwards") });
}

/** Saves settings and refreshes everything that depends on them. */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: Record<string, unknown>; message?: string }) => post("/api/settings", v.body),
    onSuccess: (_d, v) => toast.success(v.message ?? "Settings saved"),
    onError: (e) => toast.error(`Couldn't save settings: ${(e as Error).message}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: appKeys.status });
      void qc.invalidateQueries({ queryKey: appKeys.projects });
    },
  });
}

export function useKeyActions(path: string, name: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: appKeys.status });
  return {
    store: useMutation({
      mutationFn: (key: string) => post<{ stored_in: string }>(path, { key }),
      onSuccess: (r) => toast.success(`${name} API key stored in the ${r.stored_in === "keychain" ? "macOS Keychain" : "neatroots key file"}`),
      onError: (e) => toast.error(`Couldn't store the ${name} key: ${(e as Error).message}`),
      onSettled: refresh,
    }),
    remove: useMutation({ mutationFn: () => del(path), onSuccess: () => toast.success(`${name} API key removed`), onSettled: refresh }),
  };
}

export function useLayaAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "install" | "skip" | "restart" | "stop") => post(`/api/classifier/laya`, { action }),
    onError: (e) => toast.error(`Couldn't change Laya: ${(e as Error).message}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: appKeys.status }),
  });
}

const llmKey = ["llm"] as const;

/** The LLM: local status, the hosted provider, and the provider list. */
export function useLlm() {
  return useQuery({ queryKey: llmKey, queryFn: () => api<LlmInfo>("/api/llm"), refetchInterval: 15_000 });
}

export function useLlmActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: llmKey });
    void qc.invalidateQueries({ queryKey: appKeys.status });
  };
  return {
    save: useMutation({
      mutationFn: (v: { body: Record<string, unknown>; message: string }) => post<{ status: LlmInfo }>("/api/llm/external", v.body),
      onSuccess: (_r, v) => toast.success(v.message),
      onError: (e) => toast.error(`Couldn't change the LLM: ${(e as Error).message}`),
      onSettled: refresh,
    }),
    storeKey: useMutation({
      mutationFn: (v: { provider: string; key: string }) => post<{ stored_in: string }>("/api/llm/key", v),
      onSuccess: (r) => toast.success(`API key stored in the ${r.stored_in === "keychain" ? "macOS Keychain" : "neatroots key file"}`),
      onError: (e) => toast.error(`Couldn't store the key: ${(e as Error).message}`),
      onSettled: refresh,
    }),
    removeKey: useMutation({
      mutationFn: (provider: string) => del(`/api/llm/key?provider=${encodeURIComponent(provider)}`),
      onSuccess: () => toast.success("API key removed"),
      onSettled: refresh,
    }),
    models: useMutation({ mutationFn: () => api<{ models: string[] }>("/api/llm/models?target=external") }),
    test: useMutation({
      mutationFn: () => post<{ ok: boolean; where: string; model: string; latency_ms: number }>("/api/llm/test", {}),
      onSuccess: (r) =>
        r.ok
          ? toast.success(`${r.model} answered in ${r.latency_ms} ms (${r.where === "local" ? "on this machine" : r.where})`)
          : toast.error(`${r.model} answered, but not in the expected format`),
      onError: (e) => toast.error(`Test failed: ${(e as Error).message}`),
    }),
  };
}

export function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api<{ command: string[]; agents: AgentClient[] }>("/api/agents") });
}

/** Connects or disconnects a coding agent: neatroots edits that agent's own MCP config. */
export function useAgentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: "connect" | "disconnect" }) =>
      post<{ ok: boolean; message: string; note: string | null }>(`/api/agents/${v.id}/${v.action}`),
    onSuccess: (r, v) => toast.success(v.action === "connect" ? `Connected. ${r.note ?? "Start a new session in it to load neatroots."}` : "Disconnected"),
    onError: (e) => toast.error(`Couldn't change it: ${(e as Error).message}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: appKeys.status });
    },
  });
}

/** Saves how neatroots re-runs a project's agent (command or HTTP endpoint); empty values remove it. */
export function useRerunTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project: string; command?: string; cwd?: string; url?: string }) => post(`/api/projects/${encodeURIComponent(v.project)}/rerun`, { command: v.command, cwd: v.cwd, url: v.url }),
    onSuccess: (_d, v) => toast.success(v.command || v.url ? `Replay set up for ${v.project}` : `Replay removed for ${v.project}`),
    onError: (e) => toast.error(`Couldn't save: ${(e as Error).message}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: appKeys.projects }),
  });
}

export interface CloudProject {
  id: string;
  name: string;
  isDefault?: boolean;
}

/** Projects the stored service-account token can read (imports come from one of them). */
export function useCloudProjects(enabled: boolean) {
  return useQuery({ queryKey: ["cloud-projects"], queryFn: () => api<{ projects: CloudProject[]; project_id: string | null }>("/api/cloud/projects"), enabled, retry: false, staleTime: 60_000 });
}

/** The service-account token and project that importing from Neatlogs Cloud reads with. */
export function useCloudImportAuth() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: appKeys.status });
    void qc.invalidateQueries({ queryKey: ["cloud-projects"] });
    void qc.invalidateQueries({ queryKey: ["cloud-traces"] });
  };
  return {
    storeToken: useMutation({
      mutationFn: (token: string) => post<{ has_token: boolean }>("/api/cloud/import-auth", { token }),
      onSuccess: () => toast.success("Service-account token stored in the macOS Keychain"),
      onError: (e) => toast.error(`Couldn't store the token: ${(e as Error).message}`),
      onSettled: refresh,
    }),
    setProject: useMutation({
      mutationFn: (project_id: string) => post("/api/cloud/import-auth", { project_id }),
      onSuccess: () => toast.success("Import project saved"),
      onSettled: refresh,
    }),
    remove: useMutation({ mutationFn: () => del("/api/cloud/import-auth"), onSuccess: () => toast.success("Service-account token removed"), onSettled: refresh }),
  };
}
