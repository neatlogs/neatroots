import { describe, expect, it } from "vitest";
import { buildEvidence, runGoal, type TraceSnapshot } from "../src/engine/trace.js";
import type { Plain } from "../src/otlp/types.js";

const introduction = "You are a support assistant.";
const policy = "Never issue a refund without checking who owns the order.";
const user = { role: "user", content: "Refund order 4512." };

function trace(input: Plain): TraceSnapshot {
  return { traceId: "instructions", run: undefined, spans: [{
    id: "llm1", ref: "llm1", parentId: null, name: "chat", kind: "LLM", status: "ok",
    startMs: 0, endMs: 1, durationMs: 1, seq: 1, input,
    output: [{ role: "assistant", content: "Refund completed." }],
  }] };
}

describe("the run's instruction messages", () => {
  for (const first of ["system", "developer"] as const) {
    for (const second of ["system", "developer"] as const) {
      it(`retains ${first} followed by ${second}, in order`, () => {
        const snapshot = trace([{ role: first, content: introduction }, { role: second, content: policy }, user]);
        expect(runGoal(snapshot).system).toBe(`${introduction}\n\n${policy}`);
        const evidence = buildEvidence(snapshot, { fields: ["input", "output"] }).text;
        expect(evidence).toContain(`System prompt: ${introduction}\n\n${policy}`);
        expect(evidence.split(policy)).toHaveLength(2);
      });
    }
    it(`preserves a single ${first} message`, () => {
      const snapshot = trace([{ role: first, content: policy }, user]);
      expect(runGoal(snapshot).system).toBe(policy);
      expect(buildEvidence(snapshot, undefined).text).toContain(policy);
    });
  }

  it("ignores empty instructions while retaining the rest", () => {
    const snapshot = trace([
      { role: "system", content: "" }, { role: "developer" },
      { role: "system", content: introduction }, { role: "developer", content: policy }, user,
    ]);
    expect(runGoal(snapshot).system).toBe(`${introduction}\n\n${policy}`);
  });

  it("still selects the first user message and keeps the root-input fallback", () => {
    const input = [user, { role: "user", content: "A later request." }];
    expect(runGoal(trace(input))).toMatchObject({ user: user.content, rootInput: JSON.stringify(input) });
    const snapshot = trace("Review this order.");
    expect(runGoal(snapshot)).toEqual({ rootInput: "Review this order." });
    expect(buildEvidence(snapshot, undefined).text).toContain("Run input: Review this order.");
  });

  it("keeps the existing evidence limit on the combined instructions", () => {
    const snapshot = trace([
      { role: "system", content: "x".repeat(850) },
      { role: "developer", content: "y".repeat(100) + " beyond-limit" }, user,
    ]);
    const evidence = buildEvidence(snapshot, undefined).text;
    expect(evidence).toContain(`System prompt: ${"x".repeat(850)}\n\n${"y".repeat(47)}…`);
    expect(evidence).not.toContain("beyond-limit");
  });

  it("takes the goal from the first LLM call", () => {
    const snapshot = trace([{ role: "system", content: introduction }, user]);
    snapshot.spans.push({ ...snapshot.spans[0], id: "llm2", seq: 2, input: [{ role: "system", content: "Later instructions." }] });
    expect(runGoal(snapshot).system).toBe(introduction);
  });
});
