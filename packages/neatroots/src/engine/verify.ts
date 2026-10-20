import type { LlmClient } from "../models/llm.js";
import { DATA_RULE, wrapRun } from "./prompts.js";

// A second look before a question raises a finding. A yes/no answer alone can be confidently
// wrong (it may not weigh what the run did earlier), so the LLM must quote the words that show
// the problem, the quote must really be in the run, and it must still hold given the earlier run.

export const VERIFY_SYSTEM = `A check flagged a possible problem in an AI agent's run. Decide whether the evidence really shows it.
1. quote: copy the exact words from the evidence that show the problem, at most 200 characters, or "" if nothing in it does.
2. shows_problem: true only if those words show the problem, taking into account everything the run did before them (earlier tool calls and messages). An instruction is not broken when what it requires already happened earlier in the run.
${DATA_RULE}
Reply with JSON only.`;

const VERIFY_SCHEMA = {
  type: "object",
  properties: { quote: { type: "string" }, shows_problem: { type: "boolean" } },
  required: ["quote", "shows_problem"],
};

export interface Verification {
  verified: boolean;
  quote: string | null;
}

/** Lowercase, unescaped, punctuation-light text, so a quote matches the evidence it came from. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\\[nrt]/g, " ")
    .replace(/[\\"'`“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a quote (possibly shortened with an ellipsis) is really in the evidence. */
export function quoteInEvidence(quote: string, evidence: string): boolean {
  const ev = norm(evidence);
  const parts = quote
    .split(/…|\.\.\./)
    .map(norm)
    .filter((p) => p.length >= 8);
  return parts.length > 0 && parts.every((p) => ev.includes(p));
}

/**
 * Asks the LLM to back a flagged answer with a quote. Undefined when it can't be asked (no LLM, an
 * error): the caller then raises the finding as before, since a missing check is never a "no".
 */
export async function verifyFlag(llm: LlmClient, problem: string, evidence: string, signal?: AbortSignal): Promise<Verification | undefined> {
  try {
    if (!(await llm.isAvailable())) return undefined;
    const r = await llm.chat(
      [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: `Possible problem: ${problem}\n\n${wrapRun(evidence)}` },
      ],
      { schema: { name: "verification", schema: VERIFY_SCHEMA }, maxTokens: 300, temperature: 0, priority: "high", signal },
    );
    const out = r.json as { quote?: unknown; shows_problem?: unknown } | undefined;
    if (!out || typeof out.shows_problem !== "boolean") return undefined;
    const quote = typeof out.quote === "string" && out.quote.trim() ? out.quote.trim().slice(0, 300) : null;
    return { verified: out.shows_problem && !!quote && quoteInEvidence(quote, evidence), quote };
  } catch {
    return undefined;
  }
}
