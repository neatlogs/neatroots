import { isQuestion, type Check, type QuestionCheck } from "./types.js";

// A check can be valid YAML and still be unable to see what it asks about: a question about the
// agent's answer that only looks at one tool call at a time never sees the answer. These catch
// that before it is saved, and fix it when a model drafts the check.

/** Questions about what the agent said, claimed or answered (as opposed to one call's own content). */
const ABOUT_THE_ANSWER = /\b(final|answer(s|ed)?|repl(y|ies|ied)|respon(se|ses|ded|d)|told|tells?|say(s)?|said|claim(s|ed|ing)?|report(s|ed|ing)?|confirm(s|ed|ing)?|stat(es|ed|ing)|assur(es|ed))\b/i;

const isToolOnly = (c: QuestionCheck) => {
  const types = c.evidence?.spans?.type;
  const list = Array.isArray(types) ? types : types ? [types] : [];
  return list.length > 0 && list.every((t) => t === "tool" || t === "mcp_tool");
};

/** What this check can't see, in a sentence each; empty when it looks able to answer itself. */
export function checkWarnings(c: Check): string[] {
  if (!isQuestion(c) || !ABOUT_THE_ANSWER.test(c.ask)) return [];
  if (c.scope === "span") {
    return ["This question is about what the agent said, but scope: span judges one call at a time, so it never sees the answer. Use scope: trace with evidence.final_output: true."];
  }
  if (isToolOnly(c) && !c.evidence?.final_output) {
    return ["This question is about what the agent said, but its evidence is tool calls only. Add evidence.final_output: true (or llm spans) so it can see the answer."];
  }
  return [];
}

/**
 * Evidence a whole-run question needs: tool calls and LLM calls in order, plus the final answer.
 * A drafted check about what the agent said becomes a whole-run question whatever scope the model
 * picked (a session question stays session), so it can relate a tool's result to the answer.
 */
export function fitEvidence<T extends QuestionCheck>(c: T): T {
  const ask = c.ask.replace(/^\s*yes,\s*/i, "").replace(/^\w/, (x) => x.toUpperCase());
  const aboutAnswer = ABOUT_THE_ANSWER.test(ask);
  if (c.scope === "span" && !aboutAnswer) return { ...c, ask };
  return {
    ...c,
    ask,
    scope: c.scope === "session" ? "session" : "trace",
    evidence: { ...c.evidence, spans: { type: ["llm", "tool", "mcp_tool"] }, fields: c.evidence?.fields ?? ["input", "output", "status", "error"], final_output: true, last: c.evidence?.last ?? 12 },
  };
}
