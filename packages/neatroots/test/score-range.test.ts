import { describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { AnyCheck, ScoreQuestion } from "../src/checks/types.js";

const check = {
  id: "severity", kind: "score", ask: "How severe is the failure in this run?",
  levels: ["none", "minor", "major"], flag_at_level: 2,
};

describe("score thresholds fit the declared scale", () => {
  it.each([
    { levels: ["safe", "unsafe"], flag_at_level: 2 },
    { levels: check.levels, flag_at_level: 3 },
    { levels: check.levels, flag_at_level: 100 },
    { levels: check.levels, flag_at_level: 2.5 },
  ])("rejects an unreachable threshold $flag_at_level for $levels", (scale) => {
    expect(ScoreQuestion.safeParse({ ...check, ...scale }).success).toBe(false);
    expect(AnyCheck.safeParse({ ...check, ...scale }).success).toBe(false);
  });

  it.each([0, 0.5, 1, 1.75, 2])("accepts the reachable expected-score threshold %s", (flag_at_level) => {
    expect(ScoreQuestion.safeParse({ ...check, flag_at_level }).success).toBe(true);
    expect(AnyCheck.safeParse({ ...check, flag_at_level }).success).toBe(true);
  });

  it("reports the offending YAML field and keeps valid checks from the same document", () => {
    const { checks, errors } = parseChecks(JSON.stringify([
      { ...check, id: "out-of-range", flag_at_level: 3 },
      check,
    ]));
    expect(checks.map((c) => c.id)).toEqual(["severity"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: "out-of-range" });
    expect(errors[0].message).toMatch(/flag_at_level/);
    expect(errors[0].message).toMatch(/2/);
  });
});
