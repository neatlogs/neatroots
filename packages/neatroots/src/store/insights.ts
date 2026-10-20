import type Database from "better-sqlite3";

/**
 * Aggregates over a time window, compared with the window before it. Everything here is
 * computed from what the agents actually did (runs, spans, findings, decisions); nothing
 * is specific to one agent, tool or check.
 */

export const WINDOWS = {
  "24h": { ms: 86_400_000, bucketMs: 3_600_000 },
  "7d": { ms: 7 * 86_400_000, bucketMs: 86_400_000 },
  "30d": { ms: 30 * 86_400_000, bucketMs: 86_400_000 },
} as const;

export type WindowKey = keyof typeof WINDOWS;

const SKEW_MS = 5 * 60_000;

export interface CheckInfo {
  id: string;
  title: string;
  kind: string;
  enabled: boolean;
}

export interface Totals {
  runs: number;
  failed: number;
  with_problems: number;
  tokens: number;
  llm_calls: number;
  tool_calls: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface ProblemAgg {
  check_id: string;
  title: string;
  kind: string;
  runs: number;
  prev_runs: number;
  dismissed: number;
  last_ms: number;
  example_trace_id: string;
  projects: string[];
}

export interface ToolAgg {
  name: string;
  calls: number;
  failures: number;
  empty: number;
  runs: number;
  prev_calls: number;
  prev_failures: number;
  p50_ms: number | null;
}

export interface ModelAgg {
  name: string;
  calls: number;
  errors: number;
  tokens: number;
  p50_ms: number | null;
}

export interface ProjectAgg {
  name: string;
  runs: number;
  failed: number;
  with_problems: number;
  prev_runs: number;
  prev_with_problems: number;
  last_ms: number;
  top_problem: string | null;
}

export interface Insights {
  window: { key: WindowKey; from_ms: number; to_ms: number; bucket_ms: number };
  totals: Totals;
  previous: Totals;
  buckets: { start_ms: number; runs: number; failed: number; with_problems: number }[];
  problems: ProblemAgg[];
  tools: ToolAgg[];
  models: ModelAgg[];
  projects: ProjectAgg[];
  /** Checks that ran on runs in the window and found nothing. */
  passing: { check_id: string; title: string; kind: string; runs: number }[];
  /** Problems seen in the previous window and not in this one. */
  gone: { check_id: string; title: string; prev_runs: number }[];
}

interface RunRec {
  trace_id: string;
  project: string;
  status: string;
  t: number;
  dur: number | null;
  total_tokens: number;
  llm_calls: number;
  tool_calls: number;
}

interface FindingRec {
  trace_id: string;
  check_id: string;
  check_kind: string;
  title: string;
  status: string;
  created_ms: number;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const RUNS_IN = `SELECT trace_id FROM runs WHERE doctor = 0 AND COALESCE(started_ms, received_ms) >= @from AND COALESCE(started_ms, received_ms) < @to`;

/** A problem counts unless the user dismissed it, the check could not run, or it went quiet. */
const IS_PROBLEM = (f: { status: string }) => f.status !== "dismissed" && f.status !== "failed" && f.status !== "quiet";

function slice(db: Database.Database, from: number, to: number) {
  const p = { from, to };
  const runs = db
    .prepare(
      `SELECT trace_id, COALESCE(project, workflow, 'unknown') AS project, status, COALESCE(started_ms, received_ms) AS t,
        CASE WHEN ended_ms IS NOT NULL AND started_ms IS NOT NULL THEN ended_ms - started_ms END AS dur,
        total_tokens, llm_calls, tool_calls
       FROM runs WHERE doctor = 0 AND COALESCE(started_ms, received_ms) >= @from AND COALESCE(started_ms, received_ms) < @to
       ORDER BY t DESC LIMIT 20000`,
    )
    .all(p) as RunRec[];
  const findings = db
    .prepare(`SELECT trace_id, check_id, check_kind, title, status, created_ms FROM findings WHERE trace_id IN (${RUNS_IN}) LIMIT 50000`)
    .all(p) as FindingRec[];
  const problemRuns = new Set(findings.filter(IS_PROBLEM).map((f) => f.trace_id));
  const done = runs.filter((r) => r.status !== "running");
  const totals: Totals = {
    runs: runs.length,
    failed: runs.filter((r) => r.status === "error" || r.status === "interrupted").length,
    with_problems: runs.filter((r) => problemRuns.has(r.trace_id)).length,
    tokens: runs.reduce((a, r) => a + (r.total_tokens || 0), 0),
    llm_calls: runs.reduce((a, r) => a + (r.llm_calls || 0), 0),
    tool_calls: runs.reduce((a, r) => a + (r.tool_calls || 0), 0),
    p50_ms: percentile(done.flatMap((r) => (r.dur !== null ? [r.dur] : [])), 0.5),
    p95_ms: percentile(done.flatMap((r) => (r.dur !== null ? [r.dur] : [])), 0.95),
  };
  return { runs, findings, problemRuns, totals };
}

function tools(db: Database.Database, from: number, to: number) {
  const rows = db
    .prepare(
      `SELECT COALESCE(s.tool_name, s.name) AS name, s.trace_id, s.status_code, s.duration_ms,
        (SELECT json_extract(d.answer, '$.choice') FROM decisions d WHERE d.check_id = 'neatroots.tool-result' AND d.trace_id = s.trace_id AND d.span_id = s.span_id LIMIT 1) AS outcome
       FROM spans s
       WHERE s.trace_id IN (${RUNS_IN}) AND s.is_marker = 0 AND (s.tool_name IS NOT NULL OR s.span_kind IN ('TOOL', 'MCP_TOOL'))
       LIMIT 100000`,
    )
    .all({ from, to }) as { name: string; trace_id: string; status_code: number; duration_ms: number; outcome: string | null }[];
  const by = new Map<string, { calls: number; failures: number; empty: number; runs: Set<string>; durs: number[] }>();
  for (const r of rows) {
    const t = by.get(r.name) ?? { calls: 0, failures: 0, empty: 0, runs: new Set<string>(), durs: [] };
    t.calls++;
    if (r.status_code === 2 || r.outcome === "error") t.failures++;
    else if (r.outcome === "empty" || r.outcome === "partial") t.empty++;
    t.runs.add(r.trace_id);
    t.durs.push(r.duration_ms);
    by.set(r.name, t);
  }
  return by;
}

function models(db: Database.Database, from: number, to: number): ModelAgg[] {
  const rows = db
    .prepare(
      `SELECT model AS name, status_code, duration_ms, COALESCE(total_tokens, 0) AS tokens FROM spans
       WHERE trace_id IN (${RUNS_IN}) AND is_marker = 0 AND model IS NOT NULL AND span_kind = 'LLM' LIMIT 100000`,
    )
    .all({ from, to }) as { name: string; status_code: number; duration_ms: number; tokens: number }[];
  const by = new Map<string, { calls: number; errors: number; tokens: number; durs: number[] }>();
  for (const r of rows) {
    const m = by.get(r.name) ?? { calls: 0, errors: 0, tokens: 0, durs: [] };
    m.calls++;
    if (r.status_code === 2) m.errors++;
    m.tokens += r.tokens;
    m.durs.push(r.duration_ms);
    by.set(r.name, m);
  }
  return [...by].map(([name, m]) => ({ name, calls: m.calls, errors: m.errors, tokens: m.tokens, p50_ms: percentile(m.durs, 0.5) })).sort((a, b) => b.calls - a.calls);
}

export function computeInsights(db: Database.Database, key: WindowKey, checks: CheckInfo[], now = Date.now()): Insights {
  const w = WINDOWS[key];
  const to = now;
  const from = now - w.ms;
  const prevFrom = from - w.ms;
  // Span times come from the agent's clock; allow a little skew past "now".
  const until = to + SKEW_MS;
  const cur = slice(db, from, until);
  const prev = slice(db, prevFrom, from);
  const titles = new Map(checks.map((c) => [c.id, c]));

  // Activity over time.
  const bucketStart = Math.floor(from / w.bucketMs) * w.bucketMs;
  const nBuckets = Math.ceil((to - bucketStart) / w.bucketMs);
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({ start_ms: bucketStart + i * w.bucketMs, runs: 0, failed: 0, with_problems: 0 }));
  for (const r of cur.runs) {
    const b = buckets[Math.min(nBuckets - 1, Math.max(0, Math.floor((r.t - bucketStart) / w.bucketMs)))];
    b.runs++;
    if (r.status === "error" || r.status === "interrupted") b.failed++;
    if (cur.problemRuns.has(r.trace_id)) b.with_problems++;
  }

  // Problems: one row per check that found something, by how many runs it touched.
  const projectOf = new Map(cur.runs.map((r) => [r.trace_id, r.project]));
  const prevRunsByCheck = new Map<string, Set<string>>();
  for (const f of prev.findings.filter(IS_PROBLEM)) prevRunsByCheck.set(f.check_id, (prevRunsByCheck.get(f.check_id) ?? new Set()).add(f.trace_id));
  const byCheck = new Map<string, { f: FindingRec[]; runs: Set<string>; dismissed: number; quiet: number }>();
  for (const f of cur.findings) {
    if (f.status === "failed") continue;
    const e = byCheck.get(f.check_id) ?? { f: [], runs: new Set<string>(), dismissed: 0, quiet: 0 };
    if (f.status === "dismissed") e.dismissed++;
    else if (f.status === "quiet") e.quiet++;
    else {
      e.f.push(f);
      e.runs.add(f.trace_id);
    }
    byCheck.set(f.check_id, e);
  }
  // A check has nothing to report when every finding this window is dismissed, failed, or quiet.
  const reportedNothing = (id: string) => {
    const e = byCheck.get(id);
    return !e?.runs.size && !e?.quiet;
  };
  const problems: ProblemAgg[] = [...byCheck]
    .filter(([, e]) => e.runs.size > 0)
    .map(([id, e]) => {
      const latest = e.f.reduce((a, b) => (b.created_ms > a.created_ms ? b : a));
      return {
        check_id: id,
        title: titles.get(id)?.title ?? latest.title,
        kind: latest.check_kind,
        runs: e.runs.size,
        prev_runs: prevRunsByCheck.get(id)?.size ?? 0,
        dismissed: e.dismissed,
        last_ms: latest.created_ms,
        example_trace_id: latest.trace_id,
        projects: [...new Set([...e.runs].map((t) => projectOf.get(t) ?? "unknown"))],
      };
    })
    .sort((a, b) => b.runs - a.runs || b.last_ms - a.last_ms);

  // Tools, with the previous window for trends.
  const curTools = tools(db, from, until);
  const prevTools = tools(db, prevFrom, from);
  const toolAggs: ToolAgg[] = [...curTools]
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      failures: t.failures,
      empty: t.empty,
      runs: t.runs.size,
      prev_calls: prevTools.get(name)?.calls ?? 0,
      prev_failures: prevTools.get(name)?.failures ?? 0,
      p50_ms: percentile(t.durs, 0.5),
    }))
    .sort((a, b) => b.calls - a.calls);

  // Projects.
  const projects = new Map<string, ProjectAgg>();
  const topByProject = new Map<string, Map<string, number>>();
  for (const f of cur.findings.filter(IS_PROBLEM)) {
    const p = projectOf.get(f.trace_id) ?? "unknown";
    const m = topByProject.get(p) ?? new Map<string, number>();
    m.set(f.title, (m.get(f.title) ?? 0) + 1);
    topByProject.set(p, m);
  }
  for (const r of cur.runs) {
    const a = projects.get(r.project) ?? { name: r.project, runs: 0, failed: 0, with_problems: 0, prev_runs: 0, prev_with_problems: 0, last_ms: 0, top_problem: null };
    a.runs++;
    if (r.status === "error" || r.status === "interrupted") a.failed++;
    if (cur.problemRuns.has(r.trace_id)) a.with_problems++;
    a.last_ms = Math.max(a.last_ms, r.t);
    projects.set(r.project, a);
  }
  for (const r of prev.runs) {
    const a = projects.get(r.project);
    if (!a) continue;
    a.prev_runs++;
    if (prev.problemRuns.has(r.trace_id)) a.prev_with_problems++;
  }
  for (const [p, m] of topByProject) {
    const a = projects.get(p);
    if (a) a.top_problem = [...m].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }

  // Checks that ran and found nothing: questions from the decisions they made, rules on every run.
  const asked = db
    .prepare(
      `SELECT check_id, COUNT(DISTINCT trace_id) AS runs FROM decisions
       WHERE trace_id IN (${RUNS_IN}) AND check_id NOT LIKE 'neatroots.%' GROUP BY check_id`,
    )
    .all({ from, to: until }) as { check_id: string; runs: number }[];
  const ranOn = new Map(asked.map((a) => [a.check_id, a.runs]));
  for (const c of checks) if (c.kind === "rule" && c.enabled && cur.totals.runs) ranOn.set(c.id, cur.totals.runs);
  const passing = [...ranOn]
    .filter(([id]) => reportedNothing(id))
    .map(([id, runs]) => ({ check_id: id, title: titles.get(id)?.title ?? id, kind: titles.get(id)?.kind ?? "question", runs }))
    .sort((a, b) => b.runs - a.runs);

  const prevTitle = new Map(prev.findings.map((f) => [f.check_id, f.title]));
  const gone = [...prevRunsByCheck]
    .filter(([id]) => reportedNothing(id))
    .map(([id, runs]) => ({ check_id: id, title: titles.get(id)?.title ?? prevTitle.get(id) ?? id, prev_runs: runs.size }))
    .sort((a, b) => b.prev_runs - a.prev_runs);

  return {
    window: { key, from_ms: from, to_ms: to, bucket_ms: w.bucketMs },
    totals: cur.totals,
    previous: prev.totals,
    buckets,
    problems,
    tools: toolAggs,
    models: models(db, from, until),
    projects: [...projects.values()].sort((a, b) => b.runs - a.runs),
    passing,
    gone,
  };
}
