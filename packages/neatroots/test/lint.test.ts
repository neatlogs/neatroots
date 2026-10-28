import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { checkWarnings, fitEvidence } from "../src/checks/lint.js";
import { parseChecks } from "../src/checks/registry.js";
import type { QuestionCheck } from "../src/checks/types.js";

// The check QA's model drafted from "The agent claims a refund succeeded after the payment tool
// timed out": valid, saved, and blind to the answer it asks about.
const QA_DRAFT = `
id: refund-success-after-timeout
title: Did the agent report a successful refund when the payment tool call resulted in a timeout?
scope: span
ask: Yes, did the final response state that the refund succeeded despite the payment tool returning a timeout error?
evidence:
  spans:
    type: [tool, mcp_tool]
  fields: [input, output, status, error]
kind: yes_no
flag_at: 0.8
`;

describe("checks that can't see what they ask about", () => {
  it("warns about a span-scope question on the agent's answer", () => {
    const [c] = parseChecks(QA_DRAFT).checks;
    expect(checkWarnings(c)).toHaveLength(1);
    expect(checkWarnings(c)[0]).toMatch(/scope: trace/);
  });

  it("turns a drafted question about the answer into a whole-run question that sees it", () => {
    const [c] = parseChecks(QA_DRAFT).checks as QuestionCheck[];
    const fit = fitEvidence(c);
    expect(fit.scope).toBe("trace");
    expect(fit.evidence).toMatchObject({ final_output: true, spans: { type: ["llm", "tool", "mcp_tool"] } });
    expect(fit.ask).toMatch(/^Did the final response/);
    expect(checkWarnings(fit)).toEqual([]);
  });

  it("leaves a question about one call alone", () => {
    const [c] = parseChecks(`
id: negative-amount
kind: yes_no
scope: span
ask: Did this tool call pass a negative amount?
evidence: { spans: { type: [tool] }, fields: [input] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toEqual([]);
    expect(fitEvidence(c).scope).toBe("span");
  });

  it("leaves a per-reply question alone when its evidence is the LLM call itself", () => {
    // The shipped `system-prompt-violation` is this shape: `scope: span` over `type: [llm]`, asking
    // whether the reply broke an instruction. The span it is judged on IS the call whose output is
    // the reply, so it can see what it asks about and must not be widened to the whole run.
    const [c] = parseChecks(`
id: system-prompt-violation
kind: yes_no
title: Reply broke a system-prompt instruction
scope: span
ask: Does this reply break an instruction given in the system prompt? Answer yes only if the reply does something the instruction forbids or skips something it requires.
evidence:
  spans: { type: llm }
  fields: [input, output]
flag_at: 0.85
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toEqual([]);
    const fit = fitEvidence(c);
    expect(fit.scope).toBe("span");
    expect(fit.evidence).toMatchObject({ spans: { type: "llm" }, fields: ["input", "output"] });
  });

  it("still widens a per-reply question whose evidence is tool calls only", () => {
    const [c] = parseChecks(`
id: reply-after-tool
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
evidence: { spans: { type: [tool, mcp_tool] }, fields: [input, output] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toHaveLength(1);
    expect(checkWarnings(c)[0]).toMatch(/scope: trace/);
    expect(fitEvidence(c).scope).toBe("trace");
  });

  it("widens a per-reply question that reads only the input, where the reply is not described", () => {
    const [c] = parseChecks(`
id: input-only
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
evidence: { spans: { type: llm }, fields: [input] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toHaveLength(1);
    expect(fitEvidence(c).scope).toBe("trace");
  });

  it("widens a per-reply question with no span selector, which also queues tool calls", () => {
    // An omitted selector matches every span, tool calls included, and a tool call's evidence is
    // the tool result rather than a reply.
    for (const evidence of ["", "evidence: { fields: [input, output] }", "evidence: { spans: {}, fields: [input, output] }"]) {
      const [c] = parseChecks(`
id: no-selector
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
${evidence}
flag_at: 0.8
`).checks as QuestionCheck[];
      expect(checkWarnings(c), evidence || "no evidence block").toHaveLength(1);
      expect(fitEvidence(c).scope).toBe("trace");
    }
  });

  it("widens a per-reply question whose selector can also match tool calls", () => {
    const [c] = parseChecks(`
id: mixed-selector
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
evidence: { spans: { type: [llm, tool] }, fields: [input, output] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toHaveLength(1);
    expect(fitEvidence(c).scope).toBe("trace");
  });

  it("leaves a per-reply question alone when it asks for the run's final answer", () => {
    // `final_output` puts the final answer in the text whatever span is being judged, so even a
    // tool-only selector can see what the question asks about.
    const [c] = parseChecks(`
id: with-final-output
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
evidence: { spans: { type: [tool] }, fields: [input], final_output: true }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toEqual([]);
    expect(fitEvidence(c).scope).toBe("span");
  });

  it("reads the selector type case-insensitively, as the engine does", () => {
    const [c] = parseChecks(`
id: upper-llm
kind: yes_no
scope: span
ask: Did this reply claim the refund succeeded?
evidence: { spans: { type: LLM }, fields: [input, output] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(checkWarnings(c)).toEqual([]);
    expect(fitEvidence(c).scope).toBe("span");
  });

  it("warns about nothing in the shipped library", () => {
    // The library is the example people copy, so a warning about it is noise at best.
    for (const f of ["rules.yaml", "questions.yaml"]) {
      const r = parseChecks(fs.readFileSync(new URL(`../library/${f}`, import.meta.url), "utf8"));
      expect(r.errors).toEqual([]);
      const warned = r.checks.flatMap((c) => checkWarnings(c).map((w) => `${c.id}: ${w}`));
      expect(warned).toEqual([]);
    }
  });

  it("rejects a choice check whose flag_on is not one of its options", () => {
    const { checks, errors } = parseChecks(`
id: bad-choice
kind: choice
ask: What is the sentiment of the final reply?
options: { positive: positive, neutral: neutral, negative: negative }
flag_on: [angry]
`);
    expect(checks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/flag_on/);
    expect(errors[0].message).toMatch(/angry/);
  });

  it("accepts a choice check whose flag_on is a real option", () => {
    const { checks, errors } = parseChecks(`
id: good-choice
kind: choice
ask: What is the sentiment of the final reply?
options: { positive: positive, neutral: neutral, negative: negative }
flag_on: [negative]
`);
    expect(errors).toHaveLength(0);
    expect(checks).toHaveLength(1);
  });

  it("names the offending field for a bad check instead of 'Invalid input'", () => {
    // A rule with a typo'd metric (total_token, should be total_tokens).
    const { checks, errors } = parseChecks(`
id: typo-check
kind: rule
title: Token budget with a typo
rule:
  type: threshold
  metric: total_token
  at_least: 200000
`);
    expect(checks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    // Must point at the real field, not a generic top-level "Invalid input".
    expect(errors[0].message).toMatch(/rule\.metric/);
    expect(errors[0].message).not.toMatch(/^check: Invalid input$/);
  });
});
