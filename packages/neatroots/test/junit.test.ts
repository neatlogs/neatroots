import { describe, expect, it } from "vitest";
import { formatJUnit } from "../src/checks/junit.js";

describe("JUnit report", () => {
  it("counts runs and errors, retaining every finding and its evidence", () => {
    const report = formatJUnit({
      rules: ["first", "second"], errors: ["bad configuration"],
      runs: [
        { file: "a.json", trace_id: "abc", root_name: "agent", findings: [] },
        { file: "b.json", trace_id: "def", root_name: null, findings: [
          { check_id: "first", title: "Failure one", evidence_span_ids: ["span1", "span2"], params: { count: "3" } },
          { check_id: "second", title: "Failure two", evidence_span_ids: ["span3"], params: {} },
        ] },
      ],
    });
    expect(report).toContain('tests="3" failures="1" errors="1"');
    expect(report.match(/<testcase /g)).toHaveLength(3);
    expect(report.match(/<failure /g)).toHaveLength(1);
    for (const text of ["first", "second", "span1, span2", "span3", "bad configuration", "agent (abc)", "run (def)"]) {
      expect(report).toContain(text);
    }
  });

  it("escapes XML markup and removes invalid XML characters", () => {
    const report = formatJUnit({ rules: [], runs: [], errors: ['<&>"\'\n\t\r\u0000\ud800😀'] });
    expect(report).toContain("&lt;&amp;&gt;&quot;&apos;&#10;&#9;&#13;��😀");
    expect(report).not.toContain("\u0000");
  });

  it("reports an empty result without invented passes", () => {
    expect(formatJUnit({ rules: [], runs: [], errors: [] })).toContain('tests="0" failures="0" errors="0"');
  });

  it("keeps repeated trace IDs and repeated file arguments distinct in test viewers", () => {
    const run = { file: "a.json", trace_id: "same", root_name: "agent", findings: [] };
    const report = formatJUnit({ rules: [], errors: [], runs: [run, { ...run, file: "b.json" }, run] });
    const names = [...report.matchAll(/<testcase [^>]*name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(3);
    expect(report).toContain("a.json: agent (same) [occurrence 1]");
    expect(report).toContain("b.json: agent (same) [occurrence 1]");
    expect(report).toContain("a.json: agent (same) [occurrence 2]");
    const reordered = formatJUnit({ rules: [], errors: [], runs: [{ ...run, file: "b.json" }, run, run] });
    const reorderedNames = [...reordered.matchAll(/<testcase [^>]*name="([^"]+)"/g)].map((match) => match[1]);
    expect(reorderedNames.sort()).toEqual(names.sort());
  });

  it("omits all finding parameters, including captured inputs and errors", () => {
    const report = formatJUnit({ rules: ["repeat"], errors: [], runs: [{
      file: "a.json", trace_id: "trace", root_name: "agent",
      findings: [{ check_id: "repeat", title: "Repeated tool call", evidence_span_ids: ["span"],
        params: { args: "private-input-marker", error: "private-error-marker", output: "private-output-marker", count: "3" } }],
    }] });
    expect(report).toContain("repeat: Repeated tool call");
    expect(report).toContain("Evidence spans: span");
    expect(report).not.toContain("private-");
    expect(report).not.toContain("Parameters:");
  });
});
