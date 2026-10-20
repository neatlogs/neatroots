import type { NeatBadgeVariant as BadgeVariant } from "@/components/neat-ui/neat-badge";
import type { FindingStatus, NoteStatus, RunStatus } from "@/lib/api";

/** StatusPill tones (STATE family). */
export type Tone = "success" | "danger" | "warning" | "info" | "muted" | "neutral";

/** STATE mappers: outcomes that change over time. */
export const RUN_STATE: Record<RunStatus, { tone: Tone; label: string }> = {
  running: { tone: "info", label: "Running" },
  ok: { tone: "success", label: "Succeeded" },
  error: { tone: "danger", label: "Failed" },
  interrupted: { tone: "warning", label: "Interrupted" },
};

export const FINDING_STATE: Record<FindingStatus, { tone: Tone; label: string }> = {
  raised: { tone: "warning", label: "Open" },
  active: { tone: "warning", label: "Sent to agent" },
  resolved: { tone: "success", label: "Resolved" },
  dismissed: { tone: "muted", label: "Dismissed" },
  failed: { tone: "muted", label: "Not checked" },
  quiet: { tone: "muted", label: "Quiet" },
};

export const NOTE_STATE: Record<NoteStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Queued" },
  delivered: { tone: "success", label: "Delivered" },
  superseded: { tone: "muted", label: "Replaced" },
  expired: { tone: "muted", label: "Not sent" },
  blocked: { tone: "danger", label: "Blocked" },
};

/** CATEGORY mappers: fixed taxonomies, never verdicts. */
const KIND: Record<string, { variant: BadgeVariant; label: string }> = {
  LLM: { variant: "blue", label: "LLM" },
  TOOL: { variant: "amber", label: "Tool" },
  MCP_TOOL: { variant: "amber", label: "MCP" },
  AGENT: { variant: "purple", label: "Agent" },
  WORKFLOW: { variant: "tag", label: "Workflow" },
  CHAIN: { variant: "tag", label: "Chain" },
  TASK: { variant: "tag", label: "Task" },
  RETRIEVER: { variant: "green", label: "Retriever" },
  RERANKER: { variant: "green", label: "Reranker" },
  EMBEDDING: { variant: "green", label: "Embedding" },
  VECTOR_STORE: { variant: "green", label: "Vector" },
  GUARDRAIL: { variant: "outline", label: "Guardrail" },
};

export function spanKindBadge(kind: string): { variant: BadgeVariant; label: string } {
  return KIND[kind] ?? { variant: "outline", label: kind.charAt(0) + kind.slice(1).toLowerCase() };
}

export const CHECK_SOURCE: Record<string, { variant: BadgeVariant; label: string }> = {
  library: { variant: "tag", label: "Library" },
  user: { variant: "blue", label: "Yours" },
  project: { variant: "green", label: "Project" },
  planner: { variant: "purple", label: "Planner" },
  mcp: { variant: "amber", label: "Coding agent" },
};

const GOAL_KEYS = ["request", "question", "query", "input", "message", "prompt", "task", "goal", "text"];

/** What the run was asked to do, in the user's words when the input shows them. */
export function runGoal(r: { input_preview: string | null; summary: string | null }): string | null {
  const raw = r.input_preview?.trim();
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        const key = GOAL_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
        if (key) return (o[key] as string).trim();
      }
    } catch {
      // A truncated preview: look for a goal-like field, else show the text as is.
      const m = raw.match(new RegExp(`"(?:${GOAL_KEYS.join("|")})"\\s*:\\s*"((?:[^"\\\\]|\\\\.){4,})`));
      if (m) return m[1];
      if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;
    }
  }
  return r.summary?.split("\n")[0] ?? null;
}
