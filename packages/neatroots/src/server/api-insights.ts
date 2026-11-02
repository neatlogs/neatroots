import type { Hono } from "hono";
import type { Roots } from "../core.js";
import { checkTitle } from "../checks/types.js";
import { readDigest, writeDigest, type Digest } from "../engine/digest.js";
import { QUIET_AFTER } from "../engine/findings.js";
import { dismissHomeFinding, type HomeDismissTarget } from "../store/home-dismissals.js";
import { computeInsights, WINDOWS, type WindowKey } from "../store/insights.js";
import { body, err } from "./util.js";

function windowKey(v: unknown): WindowKey {
  return typeof v === "string" && v in WINDOWS ? (v as WindowKey) : "7d";
}

function insights(roots: Roots, key: WindowKey) {
  const stats = roots.store.checkStats();
  const checks = roots.checks.all().map((lc) => ({
    id: lc.check.id,
    title: checkTitle(lc.check),
    kind: lc.check.kind,
    enabled: lc.check.enabled !== false && (stats[lc.check.id]?.enabled ?? 1) === 1,
  }));
  return computeInsights(roots.store.db, key, checks);
}

/** Aggregates for the home page, and the LLM's reading of them. */
export function mountInsightsApi(app: Hono, roots: Roots): void {
  const writing = new Map<WindowKey, Promise<Digest>>();

  app.get("/api/insights", (c) => {
    const key = windowKey(c.req.query("window"));
    return c.json({ ...insights(roots, key), quiet_after: QUIET_AFTER, digest: readDigest(roots, key), digest_pending: writing.has(key) });
  });

  app.post("/api/insights/dismiss", async (c) => {
    const target = await body<HomeDismissTarget>(c);
    if (![target.finding_id, target.check_id, target.project].every((v) => typeof v === "string" && v.length > 0)) {
      return err(c, 400, "finding_id, check_id and project are required");
    }
    const result = dismissHomeFinding(roots.store, target);
    if ("error" in result) return err(c, result.status, result.error);
    if (result.changed) {
      roots.steering.withdraw(result.finding.id);
      roots.bus.emit("finding", result.finding);
    }
    return c.json({ ok: true, finding_id: result.finding.id, dismissed: roots.store.dismissalsIn(target.check_id, target.project) });
  });

  app.post("/api/insights/digest", async (c) => {
    const key = windowKey((await body<{ window?: string }>(c)).window);
    const data = insights(roots, key);
    if (!data.totals.runs) return err(c, 400, "no runs in this period");
    let job = writing.get(key);
    if (!job) {
      job = writeDigest(roots, data).finally(() => writing.delete(key));
      writing.set(key, job);
    }
    try {
      return c.json(await job);
    } catch (e) {
      return err(c, 503, (e as Error).message);
    }
  });
}
