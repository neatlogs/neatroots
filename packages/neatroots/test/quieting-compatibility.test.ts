import { afterEach, expect, it } from "vitest";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, makeRoots, span, toolSpan, until, type TestRoots } from "./helpers.js";

let tb: TestRoots | undefined;
afterEach(async () => { await tb?.close(); tb = undefined; });
const check: RuleCheck = {
  id: "quieting-compatibility", kind: "rule",
  rule: { type: "match", span: { type: "tool" }, field: "output", pattern: "quieting-trigger" },
};
async function run(project = "quiet-project", matches = true) {
  const traceId = hex(16), root = hex(8);
  tb!.roots.ingest([batch([
    span({ traceId, spanId: root, name: "quieting-run", kind: "workflow" }),
    toolSpan(traceId, root, "quieting-tool", "{}", matches ? "quieting-trigger" : "ordinary result"),
  ], project)]);
  if (!matches) { await tb!.roots.engine!.waitIdle(traceId, 5000); return { traceId }; }
  const finding = await until(() => tb!.roots.store.findingsForTrace(traceId).find(f => f.check_id === check.id));
  await tb!.roots.engine!.waitIdle(traceId, 5000);
  return { traceId, finding };
}
async function dismissThree() {
  const findings = [];
  for (let i = 0; i < 3; i++) {
    const { finding } = await run();
    expect(finding!.status).toBe("raised");
    tb!.roots.store.setFindingStatus(finding!.id, "dismissed");
    findings.push(finding!);
  }
  return findings;
}
const generation = () => (tb!.roots.store.db.prepare("SELECT metric_generation FROM checks WHERE id = ?").get(check.id) as { metric_generation: string }).metric_generation;

it.each(["planner", "mcp"] as const)("keeps project quieting when a %s check is saved to a file", async source => {
  tb = await makeRoots();
  const { roots } = tb;
  roots.checks.save(check, "db", source);
  const old = await dismissThree();
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 3, dismissed: 3, basis: "actionable_v1" });
  const previous = generation();
  const kept = roots.checks.save(check, "user", source);
  expect(kept.path).toBeTruthy();
  expect(generation()).not.toBe(previous);
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 0, dismissed: 0, basis: "actionable_v1", assessment_known: false });
  expect((await run()).finding!.status).toBe("quiet");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 0, dismissed: 0 });
  expect((await run("other-project")).finding!.status).toBe("raised");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 1, dismissed: 0, basis: "actionable_v1", assessment_known: true });
  // An old generation's later status changes must not affect current metrics.
  roots.store.setFindingStatus(old[0].id, "raised");
  roots.store.setFindingStatus(old[0].id, "dismissed");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 1, dismissed: 0 });
});

it("keeps project quieting after removing and re-adding the same check ID", async () => {
  tb = await makeRoots();
  const { roots } = tb;
  roots.checks.save(check, "user");
  await dismissThree();
  const previous = generation();
  expect(roots.checks.remove(check.id)).toBe(true);
  roots.checks.save(check, "user");
  expect(generation()).not.toBe(previous);
  expect((await run()).finding!.status).toBe("quiet");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 0, dismissed: 0, basis: "actionable_v1", assessment_known: false });
  expect((await run("other-project")).finding!.status).toBe("raised");
});

it("counts a dismissed failed row for quieting without certifying legacy metrics", async () => {
  tb = await makeRoots();
  const { roots } = tb;
  roots.checks.save(check, "db", "planner");
  for (let i = 0; i < 2; i++) roots.store.setFindingStatus((await run()).finding!.id, "dismissed");
  const { traceId } = await run("quiet-project", false);
  const failed = roots.store.insertFinding({ trace_id: traceId, check_id: check.id, check_kind: "rule", title: "Historical failed verdict", probability: null,
    status: "failed", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
  roots.store.setFindingStatus(failed.id, "dismissed");
  roots.store.db.prepare("UPDATE checks SET metric_basis = 'legacy_mixed' WHERE id = ?").run(check.id);
  expect((await run()).finding!.status).toBe("quiet");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 2, dismissed: 2, basis: "legacy_mixed", precision: null, noisy: false, assessment_known: false });
  expect((await run("other-project")).finding!.status).toBe("raised");
  expect(roots.checks.precision(check.id)).toMatchObject({ hits: 3, dismissed: 2, basis: "legacy_mixed", assessment_known: false });
});
