import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { computeInsights } from "../src/store/insights.js";
import { digestData, groundedNumbers } from "../src/engine/digest.js";
import { batch, closeTrackedStores, hex, llmSpan, span, tmpHome, toolSpan, trackedStore } from "./helpers.js";

const homes: string[] = [];
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  return trackedStore(path.join(h, "data"));
}
afterEach(() => {
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** One finished run of `service`; the tool call fails when `fail` is set. */
function run(st: Store, service: string, fail: boolean): string {
  const t = hex(16);
  const root = hex(8);
  st.ingest([
    batch(
      [
        llmSpan(t, root, { user: "refund 1001" }),
        toolSpan(t, root, "lookup_order", '{"id":1}', fail ? undefined : '{"ok":true}', fail ? "timeout" : undefined),
        toolSpan(t, root, "send_email", '{"to":"x"}', '{"sent":true}'),
        span({ traceId: t, spanId: root, name: "agent", kind: "workflow" }),
      ],
      service,
    ),
  ]);
  return t;
}

const CHECKS = [
  { id: "ignored-tool-error", title: "Carried on after a failed tool call", kind: "yes_no", enabled: true },
  { id: "secret-in-output", title: "Something that looks like a secret key in model output", kind: "rule", enabled: true },
];

describe("insights", () => {
  it("aggregates runs, problems, tools, models and passing checks from the data", () => {
    const st = store();
    const runs = [run(st, "refund-agent", true), run(st, "refund-agent", true), run(st, "refund-agent", false), run(st, "search-agent", false)];
    const base = { check_kind: "question" as const, probability: 0.9, evidence_span_ids: [], detail: {}, model: null, triage_score: 3, explanation_id: null };
    st.insertFinding({ ...base, trace_id: runs[0], check_id: "ignored-tool-error", title: "Carried on after a failed tool call", status: "raised" });
    st.insertFinding({ ...base, trace_id: runs[1], check_id: "ignored-tool-error", title: "Carried on after a failed tool call", status: "raised" });
    st.insertFinding({ ...base, trace_id: runs[2], check_id: "ignored-tool-error", title: "Carried on after a failed tool call", status: "dismissed" });
    st.insertDecision({ trace_id: runs[3], check_id: "ignored-tool-error", span_id: null, probability: 0.1, answer: { noul: 0.1 }, backend: "llm", latency_ms: 1 });

    const i = computeInsights(st.db, "7d", CHECKS);
    expect(i.totals).toMatchObject({ runs: 4, with_problems: 2, failed: 0 });
    expect(i.previous.runs).toBe(0);
    expect(i.buckets.reduce((a, b) => a + b.runs, 0)).toBe(4);

    expect(i.problems).toHaveLength(1);
    expect(i.problems[0]).toMatchObject({ check_id: "ignored-tool-error", runs: 2, dismissed: 1, projects: ["refund-agent"] });

    const lookup = i.tools.find((t) => t.name === "lookup_order")!;
    expect(lookup).toMatchObject({ calls: 4, failures: 2, runs: 4 });
    expect(i.tools.find((t) => t.name === "send_email")).toMatchObject({ calls: 4, failures: 0 });
    expect(i.models[0]).toMatchObject({ name: "mock", calls: 4, errors: 0 });

    const refund = i.projects.find((p) => p.name === "refund-agent")!;
    expect(refund).toMatchObject({ runs: 3, with_problems: 2, top_problem: "Carried on after a failed tool call" });
    expect(i.projects.find((p) => p.name === "search-agent")).toMatchObject({ runs: 1, with_problems: 0 });

    // The secret rule ran on every run and never fired; the question fired, so it is not passing.
    expect(i.passing.map((p) => p.check_id)).toEqual(["secret-in-output"]);
    expect(i.passing[0].runs).toBe(4);

    // Runs filtered by a problem's check.
    expect(st.listRuns({ checkId: "ignored-tool-error" }).map((r) => r.trace_id).sort()).toEqual([runs[0], runs[1]].sort());
  });

  it("leaves quiet findings out of the problems list, the trend and the clean lists", () => {
    const st = store();
    const runs = [run(st, "refund-agent", true), run(st, "refund-agent", true), run(st, "refund-agent", true)];
    const base = { check_kind: "question" as const, probability: 0.9, evidence_span_ids: [], detail: {}, model: null, triage_score: 3, explanation_id: null };
    const title = "Carried on after a failed tool call";
    st.insertFinding({ ...base, trace_id: runs[0], check_id: "ignored-tool-error", title, status: "raised" });
    st.insertFinding({ ...base, trace_id: runs[1], check_id: "ignored-tool-error", title, status: "quiet" });
    st.insertFinding({ ...base, trace_id: runs[2], check_id: "ignored-tool-error", title, status: "quiet" });

    const i = computeInsights(st.db, "7d", CHECKS);
    expect(i.problems).toHaveLength(1);
    expect(i.problems[0]).toMatchObject({ check_id: "ignored-tool-error", runs: 1, dismissed: 0 });
    expect(i.totals.with_problems).toBe(1);

    // A check whose findings all went quiet is not a problem, and it isn't one that found nothing either.
    const quietOnly = store();
    for (const t of [run(quietOnly, "refund-agent", true), run(quietOnly, "refund-agent", true)]) {
      quietOnly.insertFinding({ ...base, trace_id: t, check_id: "ignored-tool-error", title, status: "quiet" });
    }
    const q = computeInsights(quietOnly.db, "7d", CHECKS);
    expect(q.problems).toHaveLength(0);
    expect(q.totals.with_problems).toBe(0);
    expect(q.passing.map((p) => p.check_id)).not.toContain("ignored-tool-error");
  });

  it("lets the digest quote only numbers that are in the data", () => {
    const st = store();
    run(st, "refund-agent", true);
    const data = JSON.stringify(digestData(computeInsights(st.db, "24h", CHECKS)));
    expect(groundedNumbers("lookup_order failed on 1 of 1 calls (100 percent).", data)).toBe(true);
    expect(groundedNumbers("Problems rose 340% this week.", data)).toBe(false);
  });
});
