import type { Hono } from "hono";
import type { Roots } from "../core.js";
import { REVIEW_STATES, REVIEW_VERDICTS, reviewItem, reviewQueue, saveReview, type ReviewFilter, type ReviewVerdict } from "../store/reviews.js";
import { body, clampInt, err } from "./util.js";

export function mountReviewsApi(app: Hono, roots: Roots): void {
  app.get("/api/reviews", (c) => {
    const q = c.req.query();
    if (q.state && !REVIEW_STATES.some((state) => state === q.state)) return err(c, 400, "unknown review state");
    let cursor: ReviewFilter["cursor"];
    if (q.cursor) {
      const match = /^(\d+):(.{1,200})$/.exec(q.cursor);
      if (!match || !Number.isSafeInteger(Number(match[1]))) return err(c, 400, "invalid review cursor");
      cursor = { created_ms: Number(match[1]), id: match[2] };
    }
    return c.json(reviewQueue(roots.store, { project: q.project, check: q.check,
      state: q.state as ReviewFilter["state"], cursor, limit: clampInt(q.limit, 25, 1, 100) }));
  });

  app.get("/api/reviews/:id", (c) => {
    const item = reviewItem(roots.store, c.req.param("id"));
    if (!item) return err(c, 404, "finding not found");
    return c.json(item);
  });

  app.post("/api/reviews/:id", async (c) => {
    const b = await body<Record<string, unknown>>(c);
    const reason = b.reason === undefined ? "" : b.reason;
    if (!REVIEW_VERDICTS.some((verdict) => verdict === b.verdict)) return err(c, 400, "verdict must be correct, incorrect or uncertain");
    if (typeof reason !== "string" || reason.length > 4000) return err(c, 400, "reason must be text of at most 4000 characters");
    if (b.source !== "human" && b.source !== "tool") return err(c, 400, "source must be human or tool");
    if (typeof b.evidence_version !== "string" || !/^[a-f0-9]{64}$/.test(b.evidence_version)) return err(c, 400, "evidence_version is required; reload the finding");
    const result = saveReview(roots.store, c.req.param("id"), b.evidence_version,
      { verdict: b.verdict as ReviewVerdict, reason: reason.trim(), source: b.source });
    if (result === "missing") return err(c, 404, "finding not found");
    if (result === "stale") return err(c, 409, "Evidence changed. Reload the finding before saving a review.");
    return c.json(result);
  });
}
