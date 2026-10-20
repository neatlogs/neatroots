import type { Roots } from "../core.js";
import { projectSettings, type RootsConfig } from "../config.js";
import { listClients, type ClientStatus } from "../mcp/clients.js";
import { namedUnknownProjects } from "./project-evidence.js";

export const CONNECTION_NOTICE = "reads neatroots over MCP — its own runs are not captured";
export const CAPTURE_LIMITATIONS = [
  "Counts describe retained non-doctor runs, not all executions or archived-only history.",
  "Received telemetry establishes receipt, not producer identity or complete capture.",
  "Guidance delivered overlaps capture categories and does not prove the agent followed it.",
  "An MCP connection proves no capture; independently instrumented runs may still exist.",
  "Closed, web and unknown agents that emit no telemetry cannot be enumerated here.",
];

export function projectAuditOverride(config: RootsConfig, project: string): boolean | null {
  const entry = Object.hasOwn(config.projects, project) ? config.projects[project] : undefined;
  return entry && Object.hasOwn(entry, "audit") && typeof entry.audit === "boolean" ? entry.audit : null;
}

type Category = "traced" | "imported" | "unclassified";
type Counts = Record<Category, number> & { guidance_delivered: number };
const counts = (): Counts => ({ traced: 0, imported: 0, unclassified: 0, guidance_delivered: 0 });
type Connections = { state: "available" | "unavailable"; checked_ms: number;
  clients: { id: string; label: string; detected: boolean; connected: boolean; capture: "not_established" }[] };

/** Only aggregate local database evidence; never hydrate payloads or trust sender import flags. */
export class AuditCoverage {
  private cached?: Connections;
  constructor(private readonly roots: Roots, private readonly discover: () => ClientStatus[] = listClients,
    private readonly now = Date.now) {}

  private connections(): Connections {
    const now = this.now();
    if (this.cached && now - this.cached.checked_ms < 30_000) return this.cached;
    try {
      const clients = this.discover().map(({ id, label, detected, connected }) =>
        ({ id, label, detected, connected, capture: "not_established" as const }));
      return this.cached = { state: "available", checked_ms: now, clients };
    } catch {
      return this.cached = { state: "unavailable", checked_ms: now, clients: [] };
    }
  }

  status() {
    const rows = this.roots.store.db.prepare(`
      SELECT project, category, guidance, COUNT(*) AS n FROM (
        SELECT CASE WHEN r.project = 'unknown' AND r.trace_id NOT IN (SELECT value FROM json_each(?))
          THEN NULL ELSE NULLIF(r.project, '') END AS project,
        CASE WHEN NOT EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = r.trace_id) THEN 'unclassified'
          WHEN m.key IS NOT NULL AND (typeof(m.value) <> 'text' OR length(trim(m.value)) = 0) THEN 'unclassified'
          WHEN m.key IS NOT NULL THEN 'imported' WHEN u.trace_id IS NOT NULL THEN 'unclassified' ELSE 'traced' END AS category,
        EXISTS (SELECT 1 FROM notes n WHERE n.trace_id = r.trace_id AND n.delivered_ms IS NOT NULL) AS guidance
        FROM runs r LEFT JOIN meta m ON m.key = 'import-source:' || r.trace_id
        LEFT JOIN import_provenance_unknown u ON u.trace_id=r.trace_id WHERE r.doctor = 0
      ) GROUP BY project, category, guidance
    `).all(JSON.stringify(namedUnknownProjects(this.roots.store))) as { project: string | null; category: Category; guidance: number; n: number }[];
    const byProject = new Map<string | null, Counts>();
    const total = counts();
    for (const row of rows) {
      const project = byProject.get(row.project) ?? counts();
      project[row.category] += row.n;
      total[row.category] += row.n;
      if (row.guidance) { project.guidance_delivered += row.n; total.guidance_delivered += row.n; }
      byProject.set(row.project, project);
    }
    for (const name of Object.keys(this.roots.config.projects)) if (!byProject.has(name)) byProject.set(name, counts());
    const projects = [...byProject].map(([project, count]) => ({ project, ...count,
      audit_enabled: project === null ? false : projectSettings(this.roots.config, project).audit,
      audit_override: project === null ? null : projectAuditOverride(this.roots.config, project) }));
    projects.sort((a, b) => (a.project ?? "").localeCompare(b.project ?? ""));
    return { scope: "current_local_store" as const,
      observed_runs: total.traced + total.imported + total.unclassified,
      traced_runs: total.traced, imported_runs: total.imported, unclassified_runs: total.unclassified,
      guidance_delivered_runs: total.guidance_delivered, projects, connections: this.connections(),
      connection_notice: CONNECTION_NOTICE, limitations: CAPTURE_LIMITATIONS };
  }
}
