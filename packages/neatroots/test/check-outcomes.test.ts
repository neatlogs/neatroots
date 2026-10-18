import fs from "node:fs";
import { Store } from "../src/store/db.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CheckOutcomes } from "../src/engine/check-outcomes.js";
import { parseChecks } from "../src/checks/registry.js";
import { DecisionUnavailableError } from "../src/models/decision.js";
import { batch, hex, llmSpan, makeRoots, span, toolSpan, until, tmpHome, type TestRoots } from "./helpers.js";

const verification = vi.hoisted(() => ({ verified: true }));
vi.mock("../src/engine/verify.js", () => ({ verifyFlag: async () => ({ verified: verification.verified, quote: "observed evidence" }) }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(scope = "span", extra = "") {
  const tb = await makeRoots({ serve: true }); cleanup.push(tb.close);
  tb.roots.checks.save(parseChecks(`id: observed
kind: yes_no
scope: ${scope}
ask: Did this tool fail its task?
flag_at: 0.8
evidence: {spans: {tool: charge}}
${extra}`).checks[0], "user");
  verification.verified = true;
  vi.spyOn(tb.roots.decisions, "isSlow").mockResolvedValue(false);
  vi.spyOn(tb.roots.decisions, "decide").mockImplementation(async (_ev, qs) => ({ backend: "test", model: "test", latencyMs: 1,
    answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.1, distribution: { yes: 0.1, no: 0.9 } }])) }));
  const t = hex(16), root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { user: "charge order", out: "working" })])]);
  await tb.roots.engine!.waitIdle(t, 5000);
  return { tb, t, root };
}
function observed(tb: TestRoots, t: string) { return tb.roots.engine!.outcomes.read(t)!.checks.find((c) => c.check_id === "observed"); }
async function charge(tb: TestRoots, t: string, root: string) {
  tb.roots.ingest([batch([toolSpan(t, root, "charge", "{}", "result")])]);
  await tb.roots.engine!.waitIdle(t, 5000);
}

describe("observed live check explanations", () => {
  it("records selector misses, then actual clear and failed targets without flattening partial evidence", async () => {
    const { tb, t, root } = await setup();
    expect(observed(tb, t)?.counts.no_evidence).toBeGreaterThan(0);
    await charge(tb, t, root);
    vi.mocked(tb.roots.decisions.decide).mockRejectedValue(new DecisionUnavailableError("private provider message"));
    await charge(tb, t, root);
    const row = observed(tb, t)!;
    expect(row.counts.below_threshold).toBe(1);
    expect(row.counts.backend_unavailable).toBe(1);
    expect(row.recent.filter((x) => x.reason === "below_threshold" || x.reason === "backend_unavailable").map((x) => x.target)).toHaveLength(2);
    const clear = row.recent.find((x) => x.reason === "below_threshold")!;
    expect(row.recent.some((x) => x.reason === "evaluating" && x.attempt_id === clear.attempt_id)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("private provider message");
  });

  it("records waiting for run end, evaluation errors and missing answers without inventing a pass", async () => {
    const { tb, t, root } = await setup("trace", "when: end");
    expect(observed(tb, t)?.counts.waiting_end).toBeGreaterThan(0);
    vi.mocked(tb.roots.decisions.decide).mockRejectedValue(new Error("secret endpoint"));
    await tb.roots.engine!.recheck(t);
    tb.roots.ingest([batch([toolSpan(t, root, "charge", "{}", "result"), span({ traceId: t, spanId: root, name: "root", kind: "workflow" })])]);
    await until(() => observed(tb, t)?.counts.evaluation_error);
    expect(observed(tb, t)?.counts.below_threshold).toBeUndefined();
    vi.mocked(tb.roots.decisions.decide).mockResolvedValue({ backend: "test", model: "test", latencyMs: 1, answers: {} });
    await tb.roots.engine!.recheck(t);
    expect(observed(tb, t)?.counts.missing_answer).toBeGreaterThan(0);
    expect(observed(tb, t)?.counts.below_threshold).toBeUndefined();
  });

  it("records slow coalescing and cap separately from evaluated targets", async () => {
    const { tb, t, root } = await setup();
    vi.mocked(tb.roots.decisions.isSlow).mockResolvedValue(true);
    tb.roots.ingest([batch(Array.from({ length: 3 }, () => toolSpan(t, root, "charge", "{}", "result")))]);
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(observed(tb, t)?.counts.coalesced).toBe(2);
    for (let i = 0; i < 4; i++) await charge(tb, t, root);
    expect(observed(tb, t)?.counts.span_cap).toBe(1);
    expect(observed(tb, t)?.counts.below_threshold).toBe(4);
  });

  it("records verification rejection and subsequent suppression", async () => {
    const { tb, t, root } = await setup();
    verification.verified = false;
    vi.mocked(tb.roots.decisions.decide).mockImplementation(async (_ev, qs) => ({ backend: "test", model: "test", latencyMs: 1,
      answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.99, distribution: { yes: 0.99, no: 0.01 } }])) }));
    for (let i = 0; i < 4; i++) await charge(tb, t, root);
    expect(observed(tb, t)?.counts.verification_rejected).toBe(3);
    expect(observed(tb, t)?.counts.suppressed).toBe(1);
    expect(tb.roots.store.findingsForTrace(t).filter((f) => f.check_id === "observed")).toEqual([]);
  });

  it("records quiet flags and presents the identical document in REST and MCP without new evaluations", async () => {
    const { tb, t, root } = await setup();
    vi.spyOn(tb.roots.store, "dismissalsIn").mockReturnValue(99);
    vi.mocked(tb.roots.decisions.decide).mockImplementation(async (_ev, qs) => ({ backend: "test", model: "test", latencyMs: 1,
      answers: Object.fromEntries(qs.map((q) => [q.name, { name: q.name, type: q.type, probability: 0.99, distribution: { yes: 0.99, no: 0.01 } }])) }));
    await charge(tb, t, root);
    expect(observed(tb, t)?.counts.quiet).toBe(1);
    const before = vi.mocked(tb.roots.decisions.decide).mock.calls.length;
    const rest = await (await fetch(`${tb.url}/api/runs/${t}`)).json();
    const client = new Client({ name: "outcomes-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${tb.url}/mcp`))); cleanup.push(() => client.close());
    const result = await client.callTool({ name: "get_run_outline", arguments: { trace_id: t } });
    const content = result.content as { text: string }[];
    expect(JSON.parse(content[0].text).check_outcomes).toEqual(rest.check_outcomes);
    expect(vi.mocked(tb.roots.decisions.decide).mock.calls.length).toBe(before);
  });

  it("ignores an old in-flight result after a recheck starts a new generation", async () => {
    const { tb, t, root } = await setup();
    let release: (() => void) | undefined;
    const normal = vi.mocked(tb.roots.decisions.decide).getMockImplementation()!;
    vi.mocked(tb.roots.decisions.decide).mockImplementation(async (ev, qs, opts) => {
      if (qs[0].name === "observed" && !release) await new Promise<void>((resolve) => { release = resolve; });
      return normal(ev, qs, opts);
    });
    tb.roots.ingest([batch([toolSpan(t, root, "charge", "{}", "result")])]);
    await until(() => release);
    const old = tb.roots.engine!.outcomes.read(t)!.generation;
    await tb.roots.engine!.recheck(t);
    await until(() => observed(tb, t)?.counts.below_threshold);
    const current = tb.roots.engine!.outcomes.read(t)!;
    expect(current.generation).not.toBe(old);
    const before = JSON.stringify(observed(tb, t));
    release!();
    await tb.roots.engine!.waitIdle(t, 5000);
    expect(JSON.stringify(observed(tb, t))).toBe(before);
    expect(tb.roots.engine!.outcomes.read(t)?.generation).toBe(current.generation);
  });

  it("reports a timed-out rule as unknown rather than clear", async () => {
    const tb = await makeRoots(); cleanup.push(tb.close);
    tb.roots.checks.save(parseChecks(`id: timed-observed
kind: rule
rule: {type: match, field: output, pattern: '^(a|aa)+$'}
`).checks[0], "user");
    const t = hex(16), root = hex(8);
    tb.roots.ingest([batch([llmSpan(t, root, { user: "test", out: "a".repeat(40) + "b" })])]);
    await tb.roots.engine!.waitIdle(t, 5000);
    const row = tb.roots.engine!.outcomes.read(t)!.checks.find((c) => c.check_id === "timed-observed")!;
    expect(row.counts.rule_unknown).toBeGreaterThan(0);
    expect(row.counts.rule_clear).toBeUndefined();
  });

  it("persists through a closed/reopened store and removes outcomes during retention", () => {
    const home = tmpHome();
    let store = new Store(home);
    cleanup.push(async () => { if (store.db.open) store.close(); fs.rmSync(home, { recursive: true, force: true }); });
    const t = hex(16);
    store.ingest([batch([span({ traceId: t, spanId: hex(8), name: "old-run", kind: "workflow" })])]);
    const outcomes = new CheckOutcomes(store);
    const generation = outcomes.begin(t);
    outcomes.observe(t, generation, { id: "saved" }, "evaluation_error");
    const saved = outcomes.read(t);
    store.close();
    store = new Store(home);
    const reopened = new CheckOutcomes(store);
    expect(reopened.read(t)).toEqual(saved);
    store.db.prepare("UPDATE runs SET ended_ms = ?, received_ms = ? WHERE trace_id = ?").run(Date.now() - 3 * 86_400_000, Date.now() - 3 * 86_400_000, t);
    expect(store.sweep(1, Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(reopened.read(t)).toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM check_outcome_checks").get()).toEqual({ n: 0 });
  });

  it("bounds detail, persists identity, fences stale generations and cleans batch deletion", async () => {
    const tb = await makeRoots({ noEngine: true }); cleanup.push(tb.close);
    const t = hex(16);
    tb.roots.ingest([batch([span({ traceId: t, spanId: hex(8), name: "root", kind: "workflow" })])]);
    const outcomes = new CheckOutcomes(tb.roots.store);
    expect(outcomes.read(t)).toBeNull();
    const first = outcomes.begin(t);
    for (let i = 0; i < 70; i++) outcomes.observe(t, first, { id: "a" }, "below_threshold", String(i));
    expect(new CheckOutcomes(tb.roots.store).read(t)?.checks[0]).toMatchObject({ observations: 70, counts: { below_threshold: 70 } });
    expect(outcomes.read(t)?.checks[0].recent).toHaveLength(32);
    const second = outcomes.begin(t, "resume");
    outcomes.observe(t, first, { id: "a" }, "flagged");
    expect(outcomes.read(t)).toMatchObject({ generation: second, previous_generation: first, origin: "resume", checks: [] });
    for (let i = 0; i < 300; i++) outcomes.observe(t, second, { id: String(i) }, "no_evidence");
    expect(outcomes.read(t)?.checks).toHaveLength(256);
    expect(outcomes.read(t)?.omitted_checks).toBe(44);
    tb.roots.store.deleteRuns([t]);
    outcomes.observe(t, second, { id: "late" }, "flagged");
    expect(outcomes.read(t)).toBeNull();
    tb.roots.ingest([batch([span({ traceId: t, spanId: hex(8), name: "root", kind: "workflow" })])]);
    outcomes.begin(t);
    outcomes.observe(t, second, { id: "late" }, "flagged");
    expect(outcomes.read(t)?.checks).toEqual([]);
  });
});
