import type Database from "better-sqlite3";
import type { Finding } from "../types.js";
import { sha256 } from "../util/ids.js";
import type { Store } from "./db.js";

export const REVIEW_VERDICTS = ["correct", "incorrect", "uncertain"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_STATES = ["due", "all", "unreviewed", "stale", ...REVIEW_VERDICTS] as const;
export type ReviewState = Exclude<(typeof REVIEW_STATES)[number], "due" | "all">;

export interface FindingReview {
  verdict: ReviewVerdict;
  reason: string;
  /** Self-reported provenance, not an authenticated identity. */
  source: "human" | "tool";
  updated_ms: number;
}

export interface ReviewItem {
  finding: Finding;
  project: string | null;
  run_name: string | null;
  evidence_version: string;
  state: ReviewState;
  review: FindingReview | null;
}

export interface ReviewFilter {
  project?: string;
  check?: string;
  state?: (typeof REVIEW_STATES)[number];
  cursor?: { created_ms: number; id: string };
  limit?: number;
}

export function initReviews(db: Database.Database): void {
  db.function("review_fingerprint", { deterministic: true }, (value) => sha256(String(value)));
  db.exec(`CREATE TABLE IF NOT EXISTS finding_reviews (
    finding_id TEXT PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'uncertain')),
    reason TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('human', 'tool')),
    evidence_version TEXT NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS findings_review_order ON findings(created_ms, id);`);
}

// seq advances on every span ingest, including replacements. Conservatively re-review the
// whole run after ANY span arrives again, even an identical retransmission. No trace copy is
// stored. Lifecycle status, triage and explanations do not change the evidence fingerprint.
const QUEUE = `WITH evidence AS (
  SELECT trace_id, MAX(seq) AS seq, COUNT(*) AS spans FROM spans GROUP BY trace_id
), versions AS (
  SELECT f.*, r.project, r.root_name AS run_name,
    review_fingerprint(json_array(f.check_id, f.title, f.probability, f.evidence_span_ids,
      f.detail, f.model, c.body, e.seq, e.spans)) AS evidence_version
  FROM findings f JOIN runs r ON r.trace_id = f.trace_id
  LEFT JOIN evidence e ON e.trace_id = f.trace_id
  LEFT JOIN checks c ON c.id = f.check_id
  WHERE f.status != 'failed' AND r.doctor = 0
), queue AS (
  SELECT v.*, rv.verdict, rv.reason, rv.source, rv.updated_ms AS reviewed_ms,
    CASE WHEN rv.finding_id IS NULL THEN 'unreviewed'
      WHEN rv.evidence_version != v.evidence_version THEN 'stale'
      ELSE rv.verdict END AS review_state
  FROM versions v LEFT JOIN finding_reviews rv ON rv.finding_id = v.id
)`;

function item(row: Record<string, unknown>): ReviewItem {
  const { project, run_name, evidence_version, verdict, reason, source, reviewed_ms, review_state, ...f } = row;
  return {
    finding: { ...f, evidence_span_ids: JSON.parse(String(f.evidence_span_ids)), detail: JSON.parse(String(f.detail)) } as unknown as Finding,
    project: project as string | null,
    run_name: run_name as string | null,
    evidence_version: String(evidence_version),
    state: review_state as ReviewState,
    review: verdict ? { verdict, reason, source, updated_ms: reviewed_ms } as FindingReview : null,
  };
}

export function reviewItem(store: Store, id: string): ReviewItem | undefined {
  const row = store.db.prepare(`${QUEUE} SELECT * FROM queue WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? item(row) : undefined;
}

export function reviewQueue(store: Store, filter: ReviewFilter = {}) {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.project) { where.push("project = @project"); params.project = filter.project; }
  if (filter.check) { where.push("check_id = @check"); params.check = filter.check; }
  const state = filter.state ?? "due";
  if (state === "due") where.push("review_state IN ('unreviewed', 'stale')");
  else if (state !== "all") { where.push("review_state = @state"); params.state = state; }
  const clause = () => where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { total } = store.db.prepare(`${QUEUE} SELECT COUNT(*) AS total FROM queue ${clause()}`).get(params) as { total: number };
  if (filter.cursor) {
    where.push("(created_ms > @created OR (created_ms = @created AND id > @id))");
    params.created = filter.cursor.created_ms;
    params.id = filter.cursor.id;
  }
  const limit = Math.min(100, Math.max(1, filter.limit ?? 25));
  const rows = store.db.prepare(`${QUEUE} SELECT * FROM queue ${clause()} ORDER BY created_ms, id LIMIT @limit`).all({ ...params, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(item);
  const last = items.at(-1)?.finding;
  return { items, total, next_cursor: rows.length > limit && last ? `${last.created_ms}:${last.id}` : null };
}

/** Evidence check and upsert share one synchronous transaction; stale forms cannot judge new data. */
export function saveReview(store: Store, id: string, version: string, review: Omit<FindingReview, "updated_ms">): "missing" | "stale" | ReviewItem {
  return store.db.transaction(() => {
    const current = reviewItem(store, id);
    if (!current) return "missing";
    if (current.evidence_version !== version) return "stale";
    store.db.prepare(`INSERT INTO finding_reviews (finding_id, verdict, reason, source, evidence_version, updated_ms)
      VALUES (@id, @verdict, @reason, @source, @version, @now)
      ON CONFLICT(finding_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason,
        source = excluded.source, evidence_version = excluded.evidence_version, updated_ms = excluded.updated_ms`)
      .run({ id, version, ...review, now: Date.now() });
    return reviewItem(store, id)!;
  })();
}
