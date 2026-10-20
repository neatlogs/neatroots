import { kvToPlain, type Plain } from "../otlp/types.js";
import { maybeJson } from "../semantics/view.js";
import type { Store } from "../store/db.js";

/**
 * Serves `GET /api/traces/v3/:traceId`, the read-back the public SDKs' `doctor --probe`
 * uses to confirm a trace arrived. The shape follows what the public doctor validates:
 * one entry per span with typed node names, parsed input/output and span metadata, plus
 * trace-level token totals and a terminal status once the trace is finalized.
 */

const NODE_TYPES: Record<string, string> = {
  WORKFLOW: "workflow",
  AGENT: "agent_action",
  LLM: "llm",
  TOOL: "tool_call",
  MCP_TOOL: "tool_call",
  RETRIEVER: "retriever",
  RERANKER: "reranker",
  EMBEDDING: "embedding",
  VECTOR_STORE: "vector_store",
  MEMORY: "memory",
  GUARDRAIL: "guardrail",
  CHAIN: "chain",
  TASK: "task",
  LOG: "log",
  HTTP: "http",
  UNKNOWN: "unknown",
};

function ioValue(attrs: Record<string, Plain>, kind: string, dir: "input" | "output"): Plain | undefined {
  const k = kind.toLowerCase();
  const keys = [
    `${dir}.value`,
    `neatlogs.${dir}.value`,
    kind === "LLM" ? `neatlogs.llm.${dir}` : `neatlogs.${k}.${dir}`,
    `neatlogs.workflow.${dir}`,
    `neatlogs.agent.${dir}`,
    `neatlogs.tool.${dir}`,
  ];
  for (const key of keys) {
    const v = attrs[key];
    if (v !== undefined && v !== null && v !== "") return maybeJson(v);
  }
  return undefined;
}

export interface ReadbackResult {
  status: number;
  body: Record<string, unknown>;
}

export function traceReadback(store: Store, traceId: string): ReadbackResult {
  const run = store.getRun(traceId);
  if (!run) return { status: 404, body: { error: "trace_not_found", message: "No trace with this id has reached neatroots yet" } };
  const finalized = run.complete === 1 || run.root_ended === 1;
  if (!finalized) {
    return { status: 202, body: { _id: traceId, status: "processing", message: "Trace is still arriving" } };
  }
  const rows = store.getSpans(traceId, false);
  const spans = rows.map((row) => {
    const full = store.getOtlpSpan(traceId, row.span_id)!;
    const attrs = kvToPlain(full.span.attributes);
    const metadata = { ...kvToPlain(full.resource.attributes), ...attrs };
    return {
      span_id: row.span_id,
      parent_span_id: row.parent_span_id,
      trace_id: traceId,
      node_name: row.name,
      span_name: row.name,
      node_type: NODE_TYPES[row.span_kind] ?? row.span_kind.toLowerCase(),
      start_time: new Date(row.start_ms).toISOString(),
      end_time: new Date(row.end_ms).toISOString(),
      duration_ms: row.duration_ms,
      status: row.status_code === 2 ? "error" : "success",
      data: {
        input_value: ioValue(attrs, row.span_kind, "input") ?? null,
        output_value: ioValue(attrs, row.span_kind, "output") ?? null,
      },
      span_metadata: metadata,
    };
  });
  return {
    status: 200,
    body: {
      _id: traceId,
      status: run.status === "error" ? "error" : "success",
      spanCount: spans.length,
      promptTokens: run.prompt_tokens,
      completionTokens: run.completion_tokens,
      totalTokensUsed: run.total_tokens,
      sessionId: run.session_id,
      workflowName: run.workflow,
      startTime: run.started_ms ? new Date(run.started_ms).toISOString() : null,
      endTime: run.ended_ms ? new Date(run.ended_ms).toISOString() : null,
      spans,
    },
  };
}
