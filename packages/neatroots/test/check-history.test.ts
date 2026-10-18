import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnyCheck, type QuestionCheck } from "../src/checks/types.js";
import { checkRevision, fingerprint } from "../src/checks/canonical.js";
import { TOOLS } from "../src/mcp/tools.js";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { createApp } from "../src/server/app.js";
import { batch, hex, makeRoots, span, tmpHome, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const question = () => AnyCheck.parse({ id: "history-test", kind: "choice", ask: "Did {tool} fail?", options: { bad: "failed", good: "succeeded" }, flag_on: ["bad"], flag_at: 0.8 }) as QuestionCheck;
const result = (choice = "good") => ({ backend: "observed-backend", model: "returned-model", latencyMs: 4, answers: { "history-test": { name: "history-test", type: "choice" as const, probability: 0.99, choice, distribution: { [choice]: 0.99 } } } });

async function fixture() {
  const tb = await makeRoots();
  cleanup.push(() => tb.close());
  const traceId = hex(16);
  const seed = () => tb.roots.store.ingest([batch([span({ traceId, name: "root", kind: "workflow" })])]);
  seed();
  const engine = tb.roots.engine!;
  const run = engine["liveRun"](traceId)!;
  const ask = (check = question(), params = { tool: "lookup" }, spanId: string | null = null) => engine["decideAndApply"](run, check, params, "original evidence", ["evidence-span"], loadTrace(tb.roots.store, traceId), spanId);
  return { tb, traceId, seed, engine, run, ask };
}

describe("check revision history", () => {
  it("hashes parsed definitions independent of mapping order and explicit enabled default", () => {
    const c = question();
    expect(checkRevision(c).id).toBe(checkRevision({ enabled: true, ...Object.fromEntries(Object.entries(c).reverse()) } as QuestionCheck).id);
    expect(checkRevision(c).id).not.toBe(checkRevision({ ...c, flag_at: 0.9 }).id);
    expect(checkRevision(c).id).not.toBe(checkRevision({ ...c, evidence: { last: 2 } }).id);
  });

  it("captures definition, effective parameters and evidence before a pending call, and survives restart", async () => {
    const { tb, traceId, engine, ask } = await fixture();
    const check = question();
    const params = { tool: "lookup" };
    let finish!: (r: ReturnType<typeof result>) => void;
    vi.spyOn(engine.decisions, "decide").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = ask(check, params);
    check.ask = "Edited question";
    check.flag_at = 0.2;
    params.tool = "edited";
    finish(result());
    await pending;
    const rows = tb.roots.store.checkHistory.forTrace(traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ backend: "observed-backend", model: "returned-model", snapshot: { question: { ask: "Did lookup fail?" }, params: { tool: "lookup" }, evidence_sha256: fingerprint("original evidence"), revision: { definition: { flag_at: 0.8 } } }, execution_settings: { provider: "unknown", transport: "unknown", sampling: "unknown" } });
    expect(rows[0].decision_id).toBe(tb.roots.store.decisionsForTrace(traceId)[0].id);
    const reopened = new Store(tb.roots.store.dir);
    try { expect(reopened.checkHistory.forTrace(traceId)).toEqual(rows); } finally { reopened.close(); }
  });

  it.each([false, true])("discards pending results after run deletion (recreated=%s)", async (recreate) => {
    const { tb, traceId, engine, ask, seed } = await fixture();
    let finish!: (r: ReturnType<typeof result>) => void;
    vi.spyOn(engine.decisions, "decide").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = ask();
    tb.roots.store.deleteRun(traceId);
    if (recreate) seed();
    finish(result("bad"));
    await pending;
    expect(tb.roots.store.checkHistory.forTrace(traceId)).toEqual([]);
    expect(tb.roots.store.decisionsForTrace(traceId)).toEqual([]);
    expect(tb.roots.store.findingsForTrace(traceId)).toEqual([]);
  });

  it("keeps every aggregated question occurrence bound to its decision and revision", async () => {
    const { tb, traceId, engine, ask } = await fixture();
    vi.spyOn(engine.decisions, "decide").mockResolvedValue(result("bad"));
    await ask(question(), { tool: "one" }, "one");
    await ask({ ...question(), flag_at: 0.7 }, { tool: "two" }, "two");
    const findings = tb.roots.store.findingsForTrace(traceId);
    expect(findings).toHaveLength(1);
    const rows = tb.roots.store.checkHistory.forTrace(traceId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.finding_id)).toEqual([findings[0].id, findings[0].id]);
    expect(new Set(rows.map((r) => r.revision_id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.decision_id)).size).toBe(2);
  });

  it("records the applied LLM threshold and score comparator", async () => {
    const { tb, traceId, engine, ask } = await fixture();
    vi.spyOn(engine.decisions, "decide").mockResolvedValue({ ...result(), backend: "llm" });
    await ask({ ...question(), flag_at: 0.99 } as QuestionCheck);
    const score = AnyCheck.parse({ id: "history-test", kind: "score", ask: "How bad was the result?", levels: ["good", "bad", "worst"], flag_at_level: 2 }) as QuestionCheck;
    await ask(score);
    const settings = tb.roots.store.checkHistory.forTrace(traceId).map((r) => r.execution_settings.evaluation);
    expect(settings).toContainEqual(expect.objectContaining({ contract: "neatroots.flagged.v1", comparator: ">=", threshold: 0.88, metric: "flag_on_probability_sum" }));
    expect(settings).toContainEqual(expect.objectContaining({ comparator: ">=", threshold: 2, metric: "expected_level" }));
  });

  it("preserves rule occurrence origins as active rules change", async () => {
    const { tb, traceId, engine, run } = await fixture();
    const rule = AnyCheck.parse({ id: "history-rule", kind: "rule", rule: { type: "count", at_least: 1 } });
    tb.roots.checks.save(rule, "db", "planner");
    engine["applyRules"](run, loadTrace(tb.roots.store, traceId), true);
    tb.roots.checks.save({ ...rule, title: "Edited title" }, "db", "planner");
    engine["applyRules"](run, loadTrace(tb.roots.store, traceId), true);
    const rows = (tb.roots.store.checkHistory.forTrace(traceId)).filter((r) => r.check_id === rule.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.revision_id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.finding_id)).size).toBe(1);
    expect(rows.every((r) => r.backend === "rule" && r.model === null)).toBe(true);
    tb.roots.store.deleteRun(traceId);
    expect(tb.roots.store.checkHistory.forTrace(traceId)).toEqual([]);
    expect(tb.roots.store.db.prepare("SELECT * FROM check_history_runs WHERE trace_id = ?").get(traceId)).toBeUndefined();
  });

  it("bounds run/MCP summaries and pages full history without losing occurrences", async () => {
    const { tb, traceId, engine, ask } = await fixture();
    vi.spyOn(engine.decisions, "decide").mockResolvedValue(result("bad"));
    for (let i = 0; i < 105; i++) await ask(question(), { tool: `tool-${i}` }, `span-${i}`);
    const app = createApp(tb.roots);
    const response = await app.request(`http://localhost/api/runs/${traceId}/check-history?offset=100`, { headers: { host: "localhost" } });
    const page = await response.json();
    expect(page).toMatchObject({ total: 105, offset: 100, limit: 100, truncated: false });
    expect(page.evaluations).toHaveLength(5);
    expect(tb.roots.store.checkHistory.forTrace(traceId)).toHaveLength(100);
    const outline = await TOOLS.find((t) => t.name === "get_run_outline")!.run(tb.roots, { trace_id: traceId }) as { check_provenance: Record<string, unknown>[]; provenance_page: unknown };
    expect(outline.check_provenance).toHaveLength(25);
    expect(outline.check_provenance[0]).not.toHaveProperty("snapshot");
    expect(outline.provenance_page).toMatchObject({ total: 105, truncated: true });
    const finding = tb.roots.store.findingsForTrace(traceId)[0];
    expect(tb.roots.store.checkHistory.forFinding(finding.id)).toHaveLength(25);
    expect(tb.roots.store.checkHistory.pageInfo("finding", finding.id, 25)).toMatchObject({ total: 105, truncated: true });
  });

  it("retains active/referenced revisions while bounding unreferenced history", () => {
    const dir = tmpHome(); const store = new Store(dir);
    cleanup.push(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const old = checkRevision(question());
    store.checkHistory.setActive([question()]);
    store.db.transaction(() => {
      const insert = store.db.prepare("INSERT INTO check_revisions VALUES (?, ?, ?, ?)");
      for (let i = 0; i < 2005; i++) insert.run(`unused-${i}`, "unused", "{}", Date.now() + i);
    })();
    store.checkHistory.collect();
    expect(store.checkHistory.revisions(old.check_id)).toHaveLength(1);
    expect((store.db.prepare("SELECT count(*) n FROM check_revisions").get() as { n: number }).n).toBe(2001);
    store.checkHistory.setActive([]);
    expect(store.checkHistory.revisions(old.check_id)).toHaveLength(0);
  });

  it("exposes read-only history, leaves legacy decisions unknown, and preserves active stats", async () => {
    const { tb, traceId } = await fixture();
    const app = createApp(tb.roots);
    tb.roots.checks.save(question(), "db", "planner");
    const stats = tb.roots.store.checkStats();
    tb.roots.store.insertDecision({ trace_id: traceId, check_id: "history-test", span_id: null, probability: 0.8, answer: null, backend: "old", latency_ms: 1 });
    const response = await app.request(`http://localhost/api/checks/history-test/history`, { headers: { host: "localhost" } });
    expect(response.status).toBe(200);
    expect((await response.json()).revisions[0]).toMatchObject({ active: 1, definition: { ask: "Did {tool} fail?" } });
    const provenance = await app.request(`http://localhost/api/runs/${traceId}/check-history`, { headers: { host: "localhost" } });
    expect(await provenance.json()).toMatchObject({ evaluations: [], legacy_provenance: "unknown", total: 0, truncated: false });
    const outline = await TOOLS.find((t) => t.name === "get_run_outline")!.run(tb.roots, { trace_id: traceId }) as { check_provenance: unknown[]; legacy_provenance: string };
    expect(outline.check_provenance).toEqual([]);
    expect(outline.legacy_provenance).toBe("unknown");
    expect(tb.roots.store.checkStats()).toEqual(stats);
    expect((await app.request("http://localhost/api/runs/missing/check-history", { headers: { host: "localhost" } })).status).toBe(404);
  });
});
