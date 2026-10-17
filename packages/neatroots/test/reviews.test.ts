import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/store/db.js";
import { reviewItem, reviewQueue, saveReview } from "../src/store/reviews.js";
import { batch, closeTrackedStores, hex, makeRoots, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  closeTrackedStores();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function seed(st: Store, project = "review-agent", id = hex(8)) {
  const trace = hex(16);
  const sp = span({ traceId: trace, name: "lookup_order", kind: "tool" });
  st.ingest([batch([sp], project)]);
  st.db.prepare("INSERT OR IGNORE INTO checks(id, kind, source, body, enabled, created_ms, updated_ms) VALUES ('repeated-tool', 'rule', 'user', '{}', 1, 0, 0)").run();
  const finding = st.insertFinding({ id, trace_id: trace, check_id: "repeated-tool", check_kind: "rule", title: "Repeated tool call",
    probability: 1, status: "raised", evidence_span_ids: [sp.spanId], detail: { span_id: sp.spanId }, model: null, triage_score: null, explanation_id: null });
  return { finding, sp, trace };
}

function setup() {
  const home = tmpHome(); homes.push(home);
  const dir = path.join(home, "data");
  return { st: trackedStore(dir), dir };
}

const judgment = { verdict: "correct", reason: "The same lookup ran three times.", source: "human" } as const;

describe("local finding reviews", () => {
  it("persists one editable review after restart, independently of resolution and precision", () => {
    const { st, dir } = setup();
    const { finding } = seed(st);
    const version = reviewItem(st, finding.id)!.evidence_version;
    const stats = st.checkStats();
    expect(saveReview(st, finding.id, version, judgment)).toMatchObject({ state: "correct" });
    expect(saveReview(st, finding.id, version, { ...judgment, verdict: "uncertain", reason: "Need more context" })).toMatchObject({ state: "uncertain" });
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM finding_reviews").get()).toEqual({ n: 1 });
    expect(st.checkStats()).toEqual(stats);
    expect(st.getFinding(finding.id)!.status).toBe("raised");
    st.updateFinding(finding.id, { status: "resolved", triage_score: 3 });
    st.close();
    const reopened = trackedStore(dir);
    expect(reviewItem(reopened, finding.id)).toMatchObject({ state: "uncertain", finding: { status: "resolved" }, review: { reason: "Need more context", source: "human" } });
    expect(reviewQueue(reopened).total).toBe(0);
    expect(reviewQueue(reopened, { state: "uncertain" }).total).toBe(1);
  });

  it("invalidates on span replacement, new context, finding evidence and check changes; rejects stale saves", () => {
    const { st } = setup();
    const { finding, sp, trace } = seed(st);
    const initial = reviewItem(st, finding.id)!.evidence_version;
    saveReview(st, finding.id, initial, judgment);
    // Even within the same millisecond, ingest sequence detects replacement.
    st.ingest([batch([{ ...sp, status: { code: 2, message: "changed" } }], "review-agent")]);
    expect(reviewItem(st, finding.id)!.state).toBe("stale");
    expect(saveReview(st, finding.id, initial, judgment)).toBe("stale");
    const current = reviewItem(st, finding.id)!.evidence_version;
    saveReview(st, finding.id, current, judgment);
    st.ingest([batch([span({ traceId: trace, name: "later context", kind: "tool" })], "review-agent")]);
    expect(reviewItem(st, finding.id)!.state).toBe("stale");
    saveReview(st, finding.id, reviewItem(st, finding.id)!.evidence_version, judgment);
    st.updateFinding(finding.id, { detail: { quote: "Different evidence" } });
    expect(reviewItem(st, finding.id)!.state).toBe("stale");
    saveReview(st, finding.id, reviewItem(st, finding.id)!.evidence_version, judgment);
    st.db.prepare("UPDATE checks SET body = 'changed definition' WHERE id = ?").run(finding.check_id);
    expect(reviewQueue(st, { state: "stale" }).total).toBe(1);
  });

  it("uses project/check filters and stable keyset paging when review removes an earlier row", () => {
    const { st } = setup();
    const a = seed(st, "a", "a"); const b = seed(st, "a", "b"); seed(st, "b", "c");
    // Equal timestamps must not skip findings.
    st.db.prepare("UPDATE findings SET created_ms = 123").run();
    const first = reviewQueue(st, { project: "a", limit: 1 });
    expect(first.items[0].finding.id).toBe("a");
    expect(first.total).toBe(2);
    saveReview(st, a.finding.id, first.items[0].evidence_version, judgment);
    const next = reviewQueue(st, { project: "a", check: "repeated-tool", cursor: { created_ms: 123, id: "a" }, limit: 1 });
    expect(next.items.map((i) => i.finding.id)).toEqual([b.finding.id]);
    expect(next.next_cursor).toBeNull();
    expect(reviewQueue(st, { check: "missing" }).total).toBe(0);
    st.updateFinding(b.finding.id, { status: "failed" });
    expect(reviewQueue(st, { project: "a", state: "all" }).total).toBe(1);
  });

  it("cascades on explicit deletion and retention, preserving reviews of retained runs", () => {
    const { st } = setup();
    const a = seed(st); const b = seed(st); const c = seed(st);
    for (const { finding } of [a, b, c]) saveReview(st, finding.id, reviewItem(st, finding.id)!.evidence_version, judgment);
    st.deleteRun(a.trace);
    expect(reviewItem(st, a.finding.id)).toBeUndefined();
    st.db.prepare("UPDATE runs SET received_ms = 0, ended_ms = 0 WHERE trace_id = ?").run(b.trace);
    st.db.prepare("UPDATE runs SET pinned = 1 WHERE trace_id = ?").run(c.trace);
    st.sweep(1, Number.MAX_SAFE_INTEGER);
    expect(reviewItem(st, b.finding.id)).toBeUndefined();
    expect(reviewItem(st, c.finding.id)!.state).toBe("correct");
    expect(st.db.prepare("SELECT COUNT(*) AS n FROM finding_reviews").get()).toEqual({ n: 1 });
    expect(st.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("serves and validates reviews without an engine or model", async () => {
    const tb = await makeRoots({ noEngine: true });
    try {
      const app = createApp(tb.roots);
      const { finding, sp } = seed(tb.roots.store);
      const headers = { host: new URL(tb.url).host, "content-type": "application/json" };
      const get = (url: string) => app.request(`${tb.url}${url}`, { headers });
      const request = (url: string, json: unknown) => app.request(`${tb.url}${url}`, { method: "POST", headers, body: JSON.stringify(json) });
      const item = await (await get(`/api/reviews/${finding.id}`)).json();
      expect((await get("/api/reviews?state=wrong")).status).toBe(400);
      expect((await get("/api/reviews?cursor=wrong")).status).toBe(400);
      for (const patch of [{ verdict: "yes" }, { reason: 12 }, { reason: null }, { reason: "x".repeat(4001) }, { source: "bot" }, { evidence_version: "invalid" }]) {
        expect((await request(`/api/reviews/${finding.id}`, { ...judgment, evidence_version: item.evidence_version, ...patch })).status).toBe(400);
      }
      expect((await request(`/api/reviews/${finding.id}`, { ...judgment, evidence_version: item.evidence_version })).status).toBe(200);
      expect((await request(`/api/reviews/${finding.id}`, { verdict: "uncertain", source: "tool", evidence_version: item.evidence_version })).status).toBe(200);
      tb.roots.store.ingest([batch([sp])]);
      expect((await request(`/api/reviews/${finding.id}`, { ...judgment, evidence_version: item.evidence_version })).status).toBe(409);
      expect((await request("/api/reviews/missing", { ...judgment, evidence_version: item.evidence_version })).status).toBe(404);
      expect((await (await get("/api/reviews?state=stale")).json()).items).toHaveLength(1);
      expect(tb.roots.engine).toBeUndefined();
    } finally { await tb.close(); }
  });
});
