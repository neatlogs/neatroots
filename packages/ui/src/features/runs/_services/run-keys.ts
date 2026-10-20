export interface RunListParams {
  q: string;
  status: string;
  hasFinding: boolean;
  project: string;
  /** Runs with a finding from this check (from Home). */
  check?: string;
  /** How to show that check in the filter chip. */
  label?: string;
}

export const runKeys = {
  all: ["runs"] as const,
  lists: () => [...runKeys.all, "list"] as const,
  list: (p: RunListParams) => [...runKeys.lists(), p] as const,
  details: () => [...runKeys.all, "detail"] as const,
  detail: (traceId: string) => [...runKeys.details(), traceId] as const,
  span: (traceId: string, spanId: string) => [...runKeys.detail(traceId), "span", spanId] as const,
};

export const appKeys = {
  status: ["status"] as const,
  projects: ["projects"] as const,
  pushes: ["pushes"] as const,
  forwards: ["forwards"] as const,
  checks: ["checks"] as const,
};
