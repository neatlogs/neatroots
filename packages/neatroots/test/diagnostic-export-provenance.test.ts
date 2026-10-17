import { afterEach, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { loadTrace } from "../src/engine/trace.js";
import { batch, hex, llmSpan, makeRoots, span } from "./helpers.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

for (const secret of [
  { value: `-----BEGIN PRIVATE KEY-----\n${"SyntheticPemMaterial".repeat(250)}\n-----END PRIVATE KEY-----`, fragment: "SyntheticPemMaterial", marker: "private_key", end: "-----END PRIVATE KEY-----" },
  { value: `CLIENT-BEGIN:${"SyntheticCredentialMaterial".repeat(200)}:CLIENT-END`, fragment: "SyntheticCredentialMaterial", marker: "custom", end: ":CLIENT-END" },
]) {
  it(`omits all adjacent unverified generated text from an actual clipped planner prompt (${secret.value.slice(0, 12)})`, async () => {
    const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"]; } });
    cleanup.push(tb.close);
    const traceId = hex(16); const root = hex(8);
    tb.roots.ingest([batch([span({ traceId, spanId: root, name: "planner privacy", kind: "workflow" }), llmSpan(traceId, root, { system: secret.value, user: secret.value })])]);
    const libraryId = tb.roots.checks.library()[0].check.id;
    let system = ""; let user = "";
    vi.spyOn(tb.roots.llm, "isAvailable").mockResolvedValue(true);
    vi.spyOn(tb.roots.llm, "chat").mockImplementation(async (messages) => {
      const prompt = messages.find((m) => m.role === "user")!.content as string;
      system = prompt.split("System prompt: ")[1].split("\nFirst user message: ")[0];
      user = prompt.split("First user message: ")[1].split("\nTools:")[0];
      return { json: { checks: [{ id: libraryId, params: { instruction: user } }], new_questions: [{ id: "q1", ask: `Did the agent disclose ${system}?`, guidance: user }] }, text: "local planner fixture", model: "mock", latencyMs: 0 };
    });
    const engine = new Engine(tb.roots, tb.roots.llm, tb.roots.decisions, tb.roots.checks, tb.roots.steering);
    const run = { traceId, project: "test-agent", workflow: "test-agent", used: { plans: 0 } };
    await (engine as unknown as { plan(run: typeof run, snap: ReturnType<typeof loadTrace>, tools: string[]): Promise<void> }).plan(run, loadTrace(tb.roots.store, traceId), []);
    expect(system).toBe(`${secret.value.slice(0, 2499)}…`);
    expect(user).toBe(`${secret.value.slice(0, 799)}…`);
    expect(system).not.toContain(secret.end); expect(user).not.toContain(secret.end);
    const generated = tb.roots.checks.all().find(({ source }) => source === "planner")!.check;
    expect(generated).toMatchObject({ ask: `Did the agent disclose ${system}?`, guidance: user });
    // Adjacent persisted consumers can also contain model-supplied labels/parameters.
    tb.roots.checks.save({ ...generated, description: system, params: { instruction: user } }, "db", "planner");
    tb.roots.store.insertDecision({ trace_id: traceId, check_id: generated.id, span_id: null, probability: 0.9, answer: { choice: user, distribution: { [system]: 0.9 }, score: 1 }, backend: "mock", latency_ms: 1 });
    tb.roots.store.insertFinding({ trace_id: traceId, check_id: generated.id, check_kind: "question", title: "Generated finding", probability: 0.9, status: "raised", evidence_span_ids: [root], detail: { choice: user, group: system, backend: "mock", span_id: root }, model: "mock", triage_score: null, explanation_id: null });
    const snapshot = () => ({ checks: tb.roots.checks.all(), plan: tb.roots.store.getPlan(tb.roots.store.getRun(traceId)!.plan_id!), decisions: tb.roots.store.decisionsForTrace(traceId), findings: tb.roots.store.findingsForTrace(traceId), spans: tb.roots.store.batchesForTraces([traceId]) });
    const before = structuredClone(snapshot());
    expect(before.plan).toMatchObject({ created_by: "planner", params: { [libraryId]: { instruction: user } } });
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`); expect(response.status).toBe(200);
    const out = await response.json();
    expect(JSON.stringify(out.bundle.trace)).toContain(`[redacted:${secret.marker}]`);
    expect(JSON.stringify(out)).not.toContain(secret.fragment);
    const current = out.bundle.checks.current_definitions.find((d: { check_id: string }) => d.check_id === out.bundle.findings[0].check_id);
    expect(current).toMatchObject({ available: true, definition: null, definition_omitted: "unverified-provenance", check_kind: "yes_no" });
    expect(out.bundle.checks.historical.params).toEqual(Object.fromEntries(Object.keys(before.plan!.params).map((_, i) => [out.bundle.checks.historical.recorded_check_ids[i], null])));
    expect(out.bundle.checks.historical.params_provenance).toBe("planner");
    expect(out.bundle.checks.decisions[0].answer).toBeNull();
    expect(out.bundle.findings[0].detail).toEqual({ backend: "mock", span_id: root });
    expect(snapshot()).toEqual(before);
    // Saving an assisted check to a user file changes its location, not its authorship history.
    const keep = await fetch(`${tb.url}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check: generated }) });
    expect(keep.status).toBe(200);
    expect(await keep.json()).toMatchObject({ ok: true, source: "user", id: generated.id });
    expect(tb.roots.checks.get(generated.id)!.source).toBe("user");
    const adopted = await (await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`)).json();
    expect(JSON.stringify(adopted)).not.toContain(secret.fragment);
    expect(adopted.bundle.checks.current_definitions).toContainEqual(expect.objectContaining({ source: "user", definition: null, definition_omitted: "unverified-provenance" }));
  });
}
