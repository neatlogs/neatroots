import type { Hono } from "hono";
import type { Roots } from "../core.js";
import { checkTitle } from "../checks/types.js";
import { readDigest, writeDigest, type Digest } from "../engine/digest.js";
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
    return c.json({ ...insights(roots, key), digest: readDigest(roots, key), digest_pending: writing.has(key) });
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
