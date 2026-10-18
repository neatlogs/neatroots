export interface CaptureCoverage {
  scope: "current_local_store";
  observed_runs: number;
  traced_runs: number;
  imported_runs: number;
  unclassified_runs: number;
  guidance_delivered_runs: number;
  projects: { project: string | null; traced: number; imported: number; unclassified: number;
    guidance_delivered: number; audit_enabled: boolean; audit_override: boolean | null }[];
  connections: { state: "available" | "unavailable"; checked_ms: number;
    clients: { id: string; label: string; detected: boolean; connected: boolean; capture: "not_established" }[] };
  connection_notice: string;
  limitations: string[];
}

export interface AuditStatus {
  enabled: boolean;
  directory: string;
  covered_runs: number;
  held_runs: number;
  held_bytes: number;
  archived_live_runs: number;
  archived_live_bytes: number;
  archived_runs: number;
  archive_entries: number;
  archive_bytes: number;
  live_store_bytes: number;
  seq: number;
  head: string | null;
  verified: boolean | null;
  observation_state?: "unknown" | "current" | "stale" | "error";
  observed_ms?: number | null;
  last_observed_verified?: boolean | null;
  archive_totals_known?: boolean;
  integrity?: "not_rechecked";
  hold_reasons: Record<string, number>;
  failures: { trace_id: string; error: string }[];
  verification_errors: string[];
  coverage: CaptureCoverage;
}
