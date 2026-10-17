import type { Roots } from "../core.js";
import { loadTrace } from "../engine/trace.js";
import { runSummary } from "./api.js";

/** Shared by MCP and the local UI. All comparisons describe recorded data, not causality. */
export function compareRuns(roots: Roots, a: string, b: string) {
  const one = (traceId: string) => {
    const t = loadTrace(roots.store, traceId);
    if (!t.run) throw new Error("run not found");
    const run = t.run;
    const root = t.spans.find((s) => s.id === run.root_span_id);
    const output = root?.output;
    const spans = roots.store.getSpans(traceId, false);
    return {
      summary: { ...runSummary(roots, run), duration_ms: run.started_ms != null && run.ended_ms != null ? run.ended_ms - run.started_ms : null },
      tools: t.spans.filter((s) => s.kind === "TOOL" || s.kind === "MCP_TOOL").sort((x, y) => x.startMs - y.startMs || x.seq - y.seq).map((s) => `${s.toolName ?? s.name}${s.status === "error" ? " (failed)" : ""}`),
      output: run.output_preview && run.output_preview.length > 1200 ? run.output_preview.slice(0, 1199) + "…" : run.output_preview,
      full_output: output === undefined ? run.output_preview : typeof output === "string" ? output : JSON.stringify(output, null, 2),
      output_is_preview: output === undefined && run.output_preview !== null,
      reported_tokens: spans.some((s) => s.total_tokens !== null) ? run.total_tokens : null,
      // listFindings is paginated; comparisons must account for every recorded finding.
      problems: roots.store.findingsForTrace(traceId).reverse().filter((f) => f.status === "raised" || f.status === "active").map((f) => f.title),
    };
  };
  const x = one(a);
  const y = one(b);
  return {
    a: x,
    b: y,
    fixed: x.problems.filter((p) => !y.problems.includes(p)),
    new_problems: y.problems.filter((p) => !x.problems.includes(p)),
    persistent: [...new Set(x.problems.filter((p) => y.problems.includes(p)))],
    same_tool_sequence: JSON.stringify(x.tools) === JSON.stringify(y.tools),
  };
}
