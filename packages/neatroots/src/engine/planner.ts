import { z } from "zod";

// Check raw keys first: object parsers may discard __proto__ while constructing their output.
const Parameters = z.unknown().refine(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => !["__proto__", "prototype", "constructor"].includes(key)),
  "invalid parameter object or reserved key",
).pipe(z.record(z.string(), z.string()));

const PlannerOutput = z.object({
  rationale: z.string().optional(),
  checks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
    params: Parameters.optional(),
  })),
  new_questions: z.array(z.object({
    // Missing IDs retain the existing fallback to a slug of the question.
    id: z.string().trim().min(1).optional(),
    ask: z.string().trim().min(12),
    // Update this alongside the consumer when session planning is integrated.
    scope: z.enum(["span", "trace"]).optional(),
    span_type: z.enum(["llm", "tool", "any"]).optional(),
    guidance: z.string().optional(),
  })),
});

export type PlannerOutput = z.infer<typeof PlannerOutput>;

/** Validate the entire response before saving any generated questions or plan. */
export function parsePlannerOutput(value: unknown): PlannerOutput {
  return PlannerOutput.parse(value);
}
