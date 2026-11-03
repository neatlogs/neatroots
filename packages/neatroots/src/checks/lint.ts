import { isQuestion, type Check, type QuestionCheck } from "./types.js";

// A check can be valid YAML and still be unable to see what it asks about: a question about the
// agent's answer that only looks at one tool call at a time never sees the answer. These catch
// that before it is saved, and fix it when a model drafts the check.

/** Questions about what the agent said, claimed or answered (as opposed to one call's own content). */
const ABOUT_THE_ANSWER = /\b(final|answer(s|ed)?|repl(y|ies|ied)|respon(se|ses|ded|d)|told|tells?|say(s)?|said|claim(s|ed|ing)?|report(s|ed|ing)?|confirm(s|ed|ing)?|stat(es|ed|ing)|assur(es|ed))\b/i;

const spanTypes = (c: QuestionCheck): string[] => {
  const types = c.evidence?.spans?.type;
  const list = Array.isArray(types) ? types : types ? [types] : [];
  // `matchesSelector` compares against `s.kind.toLowerCase()`, so the selector is case-insensitive.
  return list.map((t) => t.toLowerCase());
};

const isToolOnly = (c: QuestionCheck) => {
  const list = spanTypes(c);
  return list.length > 0 && list.every((t) => t === "tool" || t === "mcp_tool");
};

/**
 * Whether every span this check is judged on can show the agent's own words. At `scope: span` a
 * check is asked about one span at a time, so each of these has to hold, and each is a way the
 * reply can still be missing:
 *
 * - the span has to be the LLM call itself, whose `output` is the reply. A selector that can also
 *   match tool spans queues those too, and a tool call's evidence is the tool result rather than a
 *   reply; a selector left out matches every span, so it counts as one that can match tools;
 * - `output` has to be among the fields read, since an input-only LLM span is described without
 *   it. The default fields include it;
 * - `final_output: true` puts the run's final answer in the text whatever span is being judged, so
 *   it makes any selector able to answer.
 *
 * The shipped `system-prompt-violation` is `scope: span` over `type: [llm]` with `input` and
 * `output`, asking whether the reply broke an instruction, so it answers itself.
 */
const canBeTheAgentWords = (c: QuestionCheck): boolean => {
  if (c.evidence?.final_output) return true;
  const types = spanTypes(c);
  if (!types.length || !types.every((t) => t === "llm")) return false;
  const fields = c.evidence?.fields;
  return fields === undefined || fields.includes("output");
};

/** What this check can't see, in a sentence each; empty when it looks able to answer itself. */
export function checkWarnings(c: Check): string[] {
  if (!isQuestion(c) || !ABOUT_THE_ANSWER.test(c.ask)) return [];
  if (c.scope === "span") {
    if (canBeTheAgentWords(c)) return [];
    return ["This question is about what the agent said, but scope: span judges one call at a time and its evidence is not the reply, so it never sees the answer. Use scope: trace with evidence.final_output: true."];
  }
  if (isToolOnly(c) && !c.evidence?.final_output) {
    return ["This question is about what the agent said, but its evidence is tool calls only. Add evidence.final_output: true (or llm spans) so it can see the answer."];
  }
  return [];
}

/**
 * Evidence a whole-run question needs: tool calls and LLM calls in order, plus the final answer.
 * A drafted check about what the agent said becomes a whole-run question, so it can relate a tool's
 * result to the answer. A span-scope draft that can show the reply is left alone: that is a
 * deliberate per-reply question, and widening it would judge the run once instead.
 */
export function fitEvidence<T extends QuestionCheck>(c: T): T {
  const ask = c.ask.replace(/^\s*yes,\s*/i, "").replace(/^\w/, (x) => x.toUpperCase());
  const aboutAnswer = ABOUT_THE_ANSWER.test(ask);
  if (c.scope === "span" && (!aboutAnswer || canBeTheAgentWords(c))) return { ...c, ask };
  return {
    ...c,
    ask,
    scope: "trace",
    evidence: { ...c.evidence, spans: { type: ["llm", "tool", "mcp_tool"] }, fields: c.evidence?.fields ?? ["input", "output", "status", "error"], final_output: true, last: c.evidence?.last ?? 12 },
  };
}
