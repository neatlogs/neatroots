import { z } from "zod";

/** Which spans a check looks at. Every field is optional; all given fields must match. */
export const SpanSelector = z
  .object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    name: z.union([z.string(), z.array(z.string())]).optional(),
    tool: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(["ok", "error", "unset", "any"]).optional(),
  })
  .strict();
export type SpanSelector = z.infer<typeof SpanSelector>;

export const EvidenceField = z.enum(["input", "output", "status", "error", "name", "model", "tokens", "duration"]);
export type EvidenceField = z.infer<typeof EvidenceField>;

export const Evidence = z
  .object({
    spans: SpanSelector.optional(),
    fields: z.array(EvidenceField).optional(),
    /** Include the run goal (first system and user messages, or the root input). Default true. */
    goal: z.boolean().optional(),
    /** Include the run's final output, when it has one. */
    final_output: z.boolean().optional(),
    /** Limit to the most recent N matching spans. */
    last: z.number().int().positive().optional(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

const AppliesTo = z
  .object({
    project: z.union([z.string(), z.array(z.string())]).optional(),
    workflow: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

const Base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "use lowercase letters, digits, dot, dash or underscore"),
  title: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  /** Library questions that apply to every agent, not only when the planner picks them. */
  baseline: z.boolean().optional(),
  applies_to: AppliesTo.optional(),
  /** Template for the note sent to the agent; {placeholders} come from the finding. */
  guidance: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Checks that describe the same kind of incident (a retry loop trips three of them). Their
   * findings in one run show and count as one problem.
   */
  group: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).optional(),
};

export const RuleSpec = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("repeat"),
      span: SpanSelector.optional(),
      /** Fields that must be equal for spans to count as repeats. */
      same: z.array(z.enum(["name", "tool", "input", "output", "status"])).default(["tool", "input"]),
      at_least: z.number().int().min(2).default(3),
    })
    .strict(),
  z
    .object({
      type: z.literal("count"),
      span: SpanSelector.optional(),
      at_least: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("errors"),
      span: SpanSelector.optional(),
      /** Fire on N errors in a row among matching spans (1 = any error). */
      consecutive: z.number().int().min(1).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("slow"),
      span: SpanSelector.optional(),
      /** Fire when a matching span took at least this many milliseconds. */
      at_least_ms: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("threshold"),
      metric: z.enum(["total_tokens", "prompt_tokens", "completion_tokens", "llm_calls", "tool_calls", "duration_ms", "span_count"]),
      at_least: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("match"),
      span: SpanSelector.optional(),
      field: z.enum(["input", "output", "error", "name"]).default("output"),
      pattern: z.string(),
      flags: z.string().optional(),
    })
    .strict()
    .superRefine((r, ctx) => {
      // Loading refuses only a pattern that doesn't compile. One that nests repeats, which checks
      // saved before 0.2.9 can have, still loads and runs under a time limit (rules.ts); saving a
      // new one is refused (checkFromInput).
      try {
        new RegExp(r.pattern, r.flags ?? "i");
      } catch (e) {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: `not a valid regular expression (${(e as Error).message})` });
      }
    }),
  z
    .object({
      type: z.literal("unrecovered_error"),
      /** Spans to watch. Defaults to tool and MCP tool calls. */
      span: SpanSelector.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("requires_before"),
      /** The calls that need something to happen first. */
      span: SpanSelector,
      /** What must have started, and succeeded, before each of them. */
      requires: SpanSelector,
    })
    .strict(),
  z
    .object({
      type: z.literal("growth"),
      /** Spans whose token count is tracked, usually llm calls. */
      span: SpanSelector.optional(),
      /** Fire once this many matching calls exist. */
      min_calls: z.number().int().min(3).default(5),
      /** Share of consecutive calls that must be bigger than the one before. */
      rising: z.number().min(0.5).max(1).default(0.8),
      /** The latest call must be at least this many times the first. */
      factor: z.number().min(1.5).default(3),
      /** The latest call must also be at least this many tokens. */
      min_tokens: z.number().int().min(1).default(4000),
    })
    .strict(),
  z
    .object({
      type: z.literal("cycle"),
      /** Spans whose order is checked, usually tool calls. */
      span: SpanSelector.optional(),
      /** Longest repeating pattern, in calls. 2 catches a, b, a, b. */
      max_period: z.number().int().min(2).max(5).default(3),
      /** How many times the pattern repeats in a row before it fires. */
      min_cycles: z.number().int().min(3).default(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("run_end"),
      /** Fire when the run ends with this condition. */
      when: z.enum(["error", "no_output", "interrupted"]),
    })
    .strict(),
]);
export type RuleSpec = z.infer<typeof RuleSpec>;

export const RuleCheck = z
  .object({
    ...Base,
    kind: z.literal("rule"),
    rule: RuleSpec,
    /** halt stops the run through the steering hook; only rules can halt. */
    action: z.enum(["flag", "halt"]).optional(),
  })
  .strict();
export type RuleCheck = z.infer<typeof RuleCheck>;

const QuestionBase = {
  ...Base,
  scope: z.enum(["span", "trace", "session"]).default("trace"),
  ask: z.string().min(8),
  evidence: Evidence.optional(),
  /** live: check as matching spans arrive and again at run end. end: only at run end. */
  when: z.enum(["live", "end"]).optional(),
  /** Values the planner filled in, available to {placeholders}. */
  params: z.record(z.string(), z.string()).optional(),
};

export const YesNoQuestion = z
  .object({
    ...QuestionBase,
    kind: z.literal("yes_no"),
    flag_at: z.number().min(0).max(1).default(0.8),
  })
  .strict();

export const ChoiceQuestion = z
  .object({
    ...QuestionBase,
    kind: z.literal("choice"),
    options: z.record(z.string(), z.string()),
    /** Options that count as a problem. */
    flag_on: z.array(z.string()).min(1),
    flag_at: z.number().min(0).max(1).default(0.6),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Every flag_on entry must be a real option key, otherwise the check can never fire.
    const keys = new Set(Object.keys(val.options));
    val.flag_on.forEach((opt, i) => {
      if (!keys.has(opt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flag_on", i],
          message: `"${opt}" is not one of options (${[...keys].join(", ")})`,
        });
      }
    });
  });

export const ScoreQuestion = z
  .object({
    ...QuestionBase,
    kind: z.literal("score"),
    levels: z.array(z.string()).min(2).max(10),
    /** Flag when the expected level reaches this (0-based). */
    flag_at_level: z.number().min(0),
  })
  .strict()
  .superRefine((val, ctx) => {
    const highest = val.levels.length - 1;
    if (val.flag_at_level > highest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flag_at_level"],
        message: `must be at most ${highest} for ${val.levels.length} levels (0-based)`,
      });
    }
  });

export const QuestionCheck = z.discriminatedUnion("kind", [YesNoQuestion, ChoiceQuestion, ScoreQuestion]);
export type QuestionCheck = z.infer<typeof QuestionCheck>;

// Discriminate on `kind` so a bad field in a check reports the specific error
// (e.g. `rule.metric: Invalid enum value`) instead of a single top-level
// `invalid_union` / "Invalid input". QuestionCheck above does the same.
export const AnyCheck = z.discriminatedUnion("kind", [RuleCheck, YesNoQuestion, ChoiceQuestion, ScoreQuestion]);
export type Check = RuleCheck | QuestionCheck;

export type CheckSource = "library" | "user" | "project" | "planner" | "mcp";

export interface LoadedCheck {
  check: Check;
  source: CheckSource;
  path: string | null;
}

export function isRule(c: Check): c is RuleCheck {
  return c.kind === "rule";
}

export function isQuestion(c: Check): c is QuestionCheck {
  return c.kind !== "rule";
}

export function checkTitle(c: Check): string {
  if (c.title) return c.title;
  if (isQuestion(c)) return c.ask;
  return c.id;
}
