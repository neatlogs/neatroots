/** Contact is process-local history, never a heartbeat or delivery receipt. */
export interface SteeringStatus {
  enabled?: boolean;
  enabled_project_count?: number;
  last_seen_ms?: number | null;
}

export function steeringContactSinceStart(value: unknown): string {
  if (value === null) return "no contact observed";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Uses the live server's effective configuration, not this CLI process's config.yaml. */
export function steeringDiagnostic(s: SteeringStatus): { level: "info" | "warn"; message: string } {
  const info = (message: string) => ({ level: "info" as const, message: `steering: ${message}` });
  if (s.enabled === false) return info("disabled by global switch (opt-in)");
  if (s.enabled !== true || !Number.isSafeInteger(s.enabled_project_count) || s.enabled_project_count! < 0) {
    return info("enabled project configuration unknown (older server)");
  }
  if (s.enabled_project_count === 0) return info("no projects have steering enabled (opt-in)");
  if (s.last_seen_ms === null) return { level: "warn", message: "steering: no hook contact observed since server start; wrap your LLM client with the steering hook, then run an agent call (docs/steering.md)" };
  const contact = steeringContactSinceStart(s.last_seen_ms);
  if (contact === "unknown") return info("hook contact history unknown (older server); see docs/steering.md for hook setup");
  return info(`last hook contact since server start ${contact}; history is not current connectivity or delivery`);
}
