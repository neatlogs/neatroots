import { afterEach, describe, expect, it } from "vitest";
import { digestData } from "../src/engine/digest.js";
import { computeInsights, type CheckInfo } from "../src/store/insights.js";
import { batch, hex, makeRoots, span, s, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

function seed(project: string | null, workflow?: string, ageMs = 0) {
  const b = batch([span({ traceId: hex(16), name: "agent", kind: "workflow" })], project ?? "placeholder");
  // Resource service and workflow names can differ, or be absent on third-party OTLP.
  b.resource.attributes = [
    ...(project === null ? [] : [s("service.name", project)]),
    ...(workflow === undefined ? [] : [s("neatlogs.workflow_name", workflow)]),
  ];
  const id = t!.roots.ingest([b])[0].traceId;
  if (project === null) t!.roots.store.db.prepare("UPDATE runs SET project = NULL WHERE trace_id = ?").run(id);
  if (ageMs) t!.roots.store.db.prepare("UPDATE runs SET started_ms = ? WHERE trace_id = ?").run(Date.now() - ageMs, id);
  return id;
}

const info = (id: string, applies_to?: CheckInfo["applies_to"], enabled = true): CheckInfo => ({ id, title: id, kind: "rule", enabled, applies_to });

function passing(checks: CheckInfo[]) {
  return computeInsights(t!.roots.store.db, "24h", checks).passing.map((c) => [c.check_id, c.runs]);
}

describe("home passing rule scope", () => {
  it("omits a project rule when every run is outside its scope, through the API", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    t.roots.checks.save({ id: "billing-only", kind: "rule", applies_to: { project: "billing-agent" }, rule: { type: "count", at_least: 99 } }, "user");
    seed("search-agent");
    const result = await (await fetch(`${t.url}/api/insights?window=24h`)).json();
    expect(result.totals.runs).toBe(1);
    expect(result.passing.some((c: { check_id: string }) => c.check_id === "billing-only")).toBe(false);
  });

  it("passes the scope from the registry to the API and digest with only matching runs", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    t.roots.checks.save({ id: "billing-only", kind: "rule", applies_to: { project: "billing-agent", workflow: ["refund"] }, rule: { type: "count", at_least: 99 } }, "user");
    seed("billing-agent", "refund");
    seed("billing-agent", "search");
    seed("search-agent", "refund");
    const result = await (await fetch(`${t.url}/api/insights?window=24h`)).json();
    expect(result.totals.runs).toBe(3);
    expect(result.passing.find((c: { check_id: string }) => c.check_id === "billing-only")?.runs).toBe(1);
    expect(digestData({ ...result, passing: result.passing.filter((c: { check_id: string }) => c.check_id === "billing-only") })["checks that found nothing"]).toContainEqual({ check: "billing-only", "runs checked": 1 });
  });

  it("matches strings and lists, requiring both project and workflow when present", async () => {
    t = await makeRoots({ noEngine: true });
    seed("billing", "refund"); seed("billing", "charge"); seed("search", "refund");
    expect(passing([
      info("global"), info("project", { project: "billing" }), info("workflow", { workflow: "refund" }),
      info("both", { project: ["billing"], workflow: ["refund", "other"] }),
      info("wrong", { project: "missing" }), info("empty", { project: [] }), info("disabled", undefined, false),
    ])).toEqual([["global", 3], ["project", 2], ["workflow", 2], ["both", 1]]);
  });

  it("uses the engine's missing-name fallbacks and excludes runs outside the window", async () => {
    t = await makeRoots({ noEngine: true });
    seed("billing"); seed(null, "refund"); seed("old", "refund", 2 * 86_400_000);
    expect(passing([
      info("fallback", { project: "billing", workflow: "billing" }),
      info("no-project", { project: "unknown", workflow: "refund" }),
      info("not-project", { project: "refund" }), info("old", { project: "old" }),
    ])).toEqual([["fallback", 1], ["no-project", 1]]);
  });

  it("does not turn a matching rule with an open finding into a passing rule", async () => {
    t = await makeRoots({ noEngine: true });
    const id = seed("billing", "refund");
    t.roots.store.insertFinding({ trace_id: id, check_id: "billing-only", check_kind: "rule", title: "billing-only", status: "raised", probability: 1, evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    expect(passing([info("billing-only", { project: "billing" })])).toEqual([]);
  });

  it("labeled smoke: 120 project/workflow selectors match their 60 controls and omit 60 unrelated scopes", async () => {
    t = await makeRoots({ noEngine: true });
    seed("billing", "refund"); seed("billing", "charge"); seed("search", "refund");
    const checks: CheckInfo[] = [];
    for (let i = 0; i < 120; i++) {
      const match = i % 2 === 0;
      checks.push(info(`scope-${i}`, i % 4 < 2
        ? { project: match ? "billing" : "missing", workflow: "refund" }
        : { project: ["billing"], workflow: [match ? "charge" : "missing"] }));
    }
    const result = new Map(passing(checks) as [string, number][]);
    expect(result.size).toBe(60);
    checks.forEach((c, i) => expect(result.get(c.id)).toBe(i % 2 === 0 ? 1 : undefined));
  });
});
