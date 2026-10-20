import type { checkFiles } from "./offline.js";

// XML 1.0 excludes control characters and unpaired UTF-16 surrogates.
function xml(value: string): string {
  return value
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\ufffd")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/** One test case per saved run; report findings without re-evaluating checks. */
export function formatJUnit(result: ReturnType<typeof checkFiles>): string {
  const failures = result.runs.filter((run) => run.findings.length > 0).length;
  const counts = `tests="${result.runs.length + result.errors.length}" failures="${failures}" errors="${result.errors.length}"`;
  const occurrences = new Map<string, number>();
  const cases = result.runs.map((run) => {
    const identity = `${run.file}: ${run.root_name ?? "run"} (${run.trace_id})`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const name = `${identity} [occurrence ${occurrence}]`;
    const open = `    <testcase classname="neatroots.check" name="${xml(name)}" file="${xml(run.file)}">`;
    if (!run.findings.length) return `${open}</testcase>`;
    const details = run.findings.map((finding) => [
      `${finding.check_id}: ${finding.title}`,
      `Evidence spans: ${finding.evidence_span_ids.join(", ")}`,
    ].join("\n")).join("\n\n");
    return `${open}\n      <failure type="agent-check" message="${xml(run.findings.map((f) => `${f.check_id}: ${f.title}`).join("; "))}">${xml(details)}</failure>\n    </testcase>`;
  });
  result.errors.forEach((error, index) => {
    cases.push(`    <testcase classname="neatroots.check" name="check error ${index + 1}"><error type="check-error" message="${xml(error)}">${xml(error)}</error></testcase>`);
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="neatroots" ${counts}>`,
    `  <testsuite name="neatroots check" ${counts}>`, ...cases, "  </testsuite>", "</testsuites>"].join("\n");
}
