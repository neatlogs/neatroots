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

  it("keeps a session question a session question", () => {
    const [c] = parseChecks(`
id: cross-turn-contradiction
kind: yes_no
scope: session
ask: Did the agent contradict what it said in an earlier turn?
evidence: { spans: { type: [llm, tool] } }
flag_at: 0.8
`).checks as QuestionCheck[];
    const fit = fitEvidence(c);
    expect(fit.scope).toBe("session");
    expect(fit.evidence).toMatchObject({ final_output: true, spans: { type: ["llm", "tool", "mcp_tool"] } });

    const [d] = parseChecks(`
id: two-turn-tool-mismatch
kind: yes_no
scope: session
ask: Did a later turn repeat a tool call that already failed earlier?
evidence: { spans: { type: [tool] }, fields: [input] }
flag_at: 0.8
`).checks as QuestionCheck[];
    expect(fitEvidence(d).scope).toBe("session");
    expect(checkWarnings(d)).toEqual([]);
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
