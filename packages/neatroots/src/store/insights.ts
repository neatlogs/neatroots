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

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const RUNS_IN = `SELECT trace_id FROM runs WHERE doctor = 0 AND COALESCE(started_ms, received_ms) >= @from AND COALESCE(started_ms, received_ms) < @to`;

// Everything below is counted in SQL, so only aggregate rows reach JS, however large the window:
// reading every run and finding of a big window into memory could exhaust the server's heap.
// Unqualified, so it matches the runs_sort index expression; findings has neither column.
const T = "COALESCE(started_ms, received_ms)";
const IN_WINDOW = `doctor = 0 AND ${T} >= @from AND ${T} < @to`;
const PROJECT = "COALESCE(project, workflow, 'unknown')";
const FAILED = "runs.status IN ('error', 'interrupted')";
/** A problem counts unless the user dismissed it, the check could not run, or it went quiet. */
const PROBLEM = "f.status NOT IN ('dismissed', 'failed', 'quiet')";
// runs.finding_count counts a run's findings under exactly the rule above (refreshFindingCounts).
const HAS_PROBLEM = "runs.finding_count > 0";
const DONE_DUR = `runs.status != 'running' AND runs.ended_ms IS NOT NULL AND runs.started_ms IS NOT NULL`;

interface RunGroup {
  bucket: number;
  project: string;
  runs: number;
  failed: number;
  with_problems: number;
  tokens: number;
  llm_calls: number;
  tool_calls: number;
  durs: number;
  last_ms: number;
}

/** A window's runs grouped by bucket and project (one row per pair that has runs). */
function runGroups(db: Database.Database, from: number, to: number, bucketStart: number, bucketMs: number, nBuckets: number): RunGroup[] {
  return db
    .prepare(
      `SELECT MIN(@n - 1, MAX(0, CAST((${T} - @start) / @size AS INTEGER))) AS bucket, ${PROJECT} AS project,
        COUNT(*) AS runs, SUM(${FAILED}) AS failed, SUM(${HAS_PROBLEM}) AS with_problems,
        SUM(runs.total_tokens) AS tokens, SUM(runs.llm_calls) AS llm_calls, SUM(runs.tool_calls) AS tool_calls,
        SUM(${DONE_DUR}) AS durs, MAX(${T}) AS last_ms
       FROM runs WHERE ${IN_WINDOW} GROUP BY 1, 2`,
    )
    .all({ from, to, n: nBuckets, start: bucketStart, size: bucketMs }) as RunGroup[];
}

/** The durations at p50 and p95 of a window's finished runs, picked the way percentile() picks them. */
function durationPercentiles(db: Database.Database, from: number, to: number, n: number): { p50_ms: number | null; p95_ms: number | null } {
  if (!n) return { p50_ms: null, p95_ms: null };
  const rank = (p: number) => Math.min(n - 1, Math.floor(p * n)) + 1;
  const rows = db
    .prepare(
      `SELECT k, d FROM (SELECT runs.ended_ms - runs.started_ms AS d, ROW_NUMBER() OVER (ORDER BY runs.ended_ms - runs.started_ms) AS k
        FROM runs WHERE ${IN_WINDOW} AND ${DONE_DUR}) WHERE k IN (@a, @b)`,
    )
    .all({ from, to, a: rank(0.5), b: rank(0.95) }) as { k: number; d: number }[];
  const at = (k: number) => rows.find((r) => r.k === k)?.d ?? null;
  return { p50_ms: at(rank(0.5)), p95_ms: at(rank(0.95)) };
}

function totalsOf(db: Database.Database, from: number, to: number, groups: RunGroup[]): Totals {
  const sum = (k: keyof RunGroup) => groups.reduce((a, g) => a + ((g[k] as number) || 0), 0);
  return {
    runs: sum("runs"),
    failed: sum("failed"),
    with_problems: sum("with_problems"),
    tokens: sum("tokens"),
    llm_calls: sum("llm_calls"),
    tool_calls: sum("tool_calls"),
    ...durationPercentiles(db, from, to, sum("durs")),
  };
}

interface CheckProject {
  check_id: string;
  project: string;
  runs: number;
  dismissed: number;
  quiet: number;
  last_ms: number | null;
  title: string;
  check_kind: string;
  trace_id: string;
}

/**
 * A window's findings grouped by check and project. A run belongs to one project, so a check's runs
 * add up across projects. With a single max(), SQLite takes title, kind and trace from the latest problem.
 */
function checkProjects(db: Database.Database, from: number, to: number): CheckProject[] {
  return db
    .prepare(
      `SELECT f.check_id, ${PROJECT} AS project,
        COUNT(DISTINCT CASE WHEN ${PROBLEM} THEN f.trace_id END) AS runs,
        SUM(f.status = 'dismissed') AS dismissed, SUM(f.status = 'quiet') AS quiet,
        MAX(CASE WHEN ${PROBLEM} THEN f.created_ms END) AS last_ms, f.title, f.check_kind, f.trace_id
       FROM runs JOIN findings f ON f.trace_id = runs.trace_id WHERE ${IN_WINDOW} AND f.status != 'failed' GROUP BY 1, 2`,
    )
    .all({ from, to }) as CheckProject[];
}

interface CheckAgg {
  runs: number;
  dismissed: number;
  quiet: number;
  last_ms: number;
  title: string;
  check_kind: string;
  trace_id: string;
  projects: string[];
}

function byCheck(rows: CheckProject[]): Map<string, CheckAgg> {
  const out = new Map<string, CheckAgg>();
  for (const r of rows) {
    const e = out.get(r.check_id) ?? { runs: 0, dismissed: 0, quiet: 0, last_ms: -Infinity, title: r.title, check_kind: r.check_kind, trace_id: r.trace_id, projects: [] };
    e.runs += r.runs;
    e.dismissed += r.dismissed;
    e.quiet += r.quiet;
    if (r.runs) e.projects.push(r.project);
    if (r.last_ms !== null && r.last_ms > e.last_ms) Object.assign(e, { last_ms: r.last_ms, title: r.title, check_kind: r.check_kind, trace_id: r.trace_id });
    out.set(r.check_id, e);
  }
  for (const e of out.values()) e.projects.sort();
  return out;
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
  const titles = new Map(checks.map((c) => [c.id, c]));

  // Activity over time, and the totals and projects from the same grouped runs.
  const bucketStart = Math.floor(from / w.bucketMs) * w.bucketMs;
  const nBuckets = Math.ceil((to - bucketStart) / w.bucketMs);
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({ start_ms: bucketStart + i * w.bucketMs, runs: 0, failed: 0, with_problems: 0 }));
  const groups = runGroups(db, from, until, bucketStart, w.bucketMs, nBuckets);
  for (const g of groups) {
    const b = buckets[g.bucket];
    b.runs += g.runs;
    b.failed += g.failed;
    b.with_problems += g.with_problems;
  }
  const prevGroups = runGroups(db, prevFrom, from, prevFrom, w.ms, 1);
  const totals = totalsOf(db, from, until, groups);

  // Problems: one row per check that found something, by how many runs it touched.
  const cur = byCheck(checkProjects(db, from, until));
  const prev = new Map([...byCheck(checkProjects(db, prevFrom, from))].filter(([, e]) => e.runs > 0));
  // A check has nothing to report when every finding this window is dismissed, failed, or quiet.
  const reportedNothing = (id: string) => {
    const e = cur.get(id);
    return !e?.runs && !e?.quiet;
  };
  const problems: ProblemAgg[] = [...cur]
    .filter(([, e]) => e.runs > 0)
    .map(([id, e]) => ({
      check_id: id,
      title: titles.get(id)?.title ?? e.title,
      kind: e.check_kind,
      runs: e.runs,
      prev_runs: prev.get(id)?.runs ?? 0,
      dismissed: e.dismissed,
      last_ms: e.last_ms,
      example_trace_id: e.trace_id,
      projects: e.projects,
    }))
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

  // Projects, with the problem each one found most often.
  const topProblem = new Map(
    (
      db
        .prepare(
          `SELECT project, title FROM (
             SELECT ${PROJECT} AS project, f.title, ROW_NUMBER() OVER (PARTITION BY ${PROJECT} ORDER BY COUNT(*) DESC, f.title) AS k
             FROM runs JOIN findings f ON f.trace_id = runs.trace_id WHERE ${IN_WINDOW} AND ${PROBLEM} GROUP BY 1, 2)
           WHERE k = 1`,
        )
        .all({ from, to: until }) as { project: string; title: string }[]
    ).map((r) => [r.project, r.title]),
  );
  const projects = new Map<string, ProjectAgg>();
  for (const g of groups) {
    const a = projects.get(g.project) ?? { name: g.project, runs: 0, failed: 0, with_problems: 0, prev_runs: 0, prev_with_problems: 0, last_ms: 0, top_problem: null };
    a.runs += g.runs;
    a.failed += g.failed;
    a.with_problems += g.with_problems;
    a.last_ms = Math.max(a.last_ms, g.last_ms);
    projects.set(g.project, a);
  }
  for (const g of prevGroups) {
    const a = projects.get(g.project);
    if (!a) continue;
    a.prev_runs += g.runs;
    a.prev_with_problems += g.with_problems;
  }
  for (const [p, title] of topProblem) {
    const a = projects.get(p);
    if (a) a.top_problem = title;
  }

  // Checks that ran and found nothing: questions from the decisions they made, rules on every run.
  const asked = db
    .prepare(
      `SELECT check_id, COUNT(DISTINCT trace_id) AS runs FROM decisions
       WHERE trace_id IN (${RUNS_IN}) AND check_id NOT LIKE 'neatroots.%' GROUP BY check_id`,
    )
    .all({ from, to: until }) as { check_id: string; runs: number }[];
  const ranOn = new Map(asked.map((a) => [a.check_id, a.runs]));
  for (const c of checks) if (c.kind === "rule" && c.enabled && totals.runs) ranOn.set(c.id, totals.runs);
  const passing = [...ranOn]
    .filter(([id]) => reportedNothing(id))
    .map(([id, runs]) => ({ check_id: id, title: titles.get(id)?.title ?? id, kind: titles.get(id)?.kind ?? "question", runs }))
    .sort((a, b) => b.runs - a.runs);

  const gone = [...prev]
    .filter(([id]) => reportedNothing(id))
    .map(([id, e]) => ({ check_id: id, title: titles.get(id)?.title ?? e.title, prev_runs: e.runs }))
    .sort((a, b) => b.prev_runs - a.prev_runs);

  return {
    window: { key, from_ms: from, to_ms: to, bucket_ms: w.bucketMs },
    totals,
    previous: totalsOf(db, prevFrom, from, prevGroups),
    buckets,
    problems,
    tools: toolAggs,
    models: models(db, from, until),
    projects: [...projects.values()].sort((a, b) => b.runs - a.runs || b.last_ms - a.last_ms),
    passing,
    gone,
  };
}
