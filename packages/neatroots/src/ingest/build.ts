import crypto from "node:crypto";
import type { KeyValue, OtlpSpan, ResourceSpansBatch } from "../otlp/types.js";
import { plainToAny, STATUS_ERROR, STATUS_OK } from "../otlp/types.js";

// Turns spans described in other shapes (the Neatlogs HTTP API, Neatlogs Cloud exports, replays)
// into OTLP spans with the public neatlogs.* attributes, so everything after
// ingest (views, checks, search, cloud forwarding) treats them like SDK spans.

export interface SpanNode {
  /** Ids from the source; hashed into OTLP-sized hex ids when they aren't already. */
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  /** A Neatlogs span kind (LLM, TOOL, AGENT, WORKFLOW, RETRIEVER, …) or a close alias. */
  kind?: string | null;
  start: TimeLike;
  end?: TimeLike | null;
  durationMs?: number | null;
  status?: "OK" | "ERROR" | string | null;
  error?: string | null;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  provider?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  toolName?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  /** Extra attributes, written as they are (use neatlogs.* keys where one exists). */
  attributes?: Record<string, unknown>;
  logs?: { level?: string; message: string; timestamp?: TimeLike }[];
}

export type TimeLike = string | number | Date;

/** Nanoseconds since the epoch, as OTLP wants them. Numbers are ms, s or ns by magnitude. */
export function toNs(t: TimeLike | null | undefined): bigint | undefined {
  if (t === undefined || t === null || t === "") return undefined;
  if (t instanceof Date) return BigInt(t.getTime()) * 1_000_000n;
  if (typeof t === "number") {
    if (!Number.isFinite(t)) return undefined;
    if (t > 1e17) return BigInt(Math.round(t)); // ns
    if (t > 1e14) return BigInt(Math.round(t)) * 1_000n; // µs
    if (t > 1e11) return BigInt(Math.round(t * 1e6)); // ms
    return BigInt(Math.round(t * 1e9)); // s
  }
  if (/^\d+$/.test(t)) return toNs(Number(t)) ?? undefined;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    // An epoch with a fraction sent as a string ("1700000000.5") reads like the same number,
    // instead of falling back to the time it arrived.
    return /^\d+\.\d+$/.test(t) ? toNs(Number(t)) : undefined;
  }
  // Keep sub-millisecond digits when the string has them (ClickHouse and OTLP style).
  const frac = /\.(\d+)/.exec(t)?.[1] ?? "";
  const extraNs = frac.length > 3 ? BigInt(frac.slice(3, 9).padEnd(6, "0")) : 0n;
  return BigInt(ms) * 1_000_000n + extraNs;
}

/** A stable OTLP-sized hex id for any source id (16 bytes for traces, 8 for spans). */
export function hexId(source: string, bytes: 16 | 8): string {
  const clean = source.toLowerCase().replace(/-/g, "");
  if (/^[0-9a-f]+$/.test(clean) && clean.length === bytes * 2) return clean;
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, bytes * 2);
}

const KIND_ALIAS: Record<string, string> = {
  generation: "llm",
  chat: "llm",
  completion: "llm",
  llm: "llm",
  prompt: "chain",
  parser: "chain",
  chain: "chain",
  span: "chain",
  function: "tool",
  tool: "tool",
  tool_call: "tool",
  mcp_tool: "mcp_tool",
  retriever: "retriever",
  retrieval: "retriever",
  embedding: "embedding",
  reranker: "reranker",
  agent: "agent",
  workflow: "workflow",
  task: "task",
  guardrail: "guardrail",
  event: "log",
  log: "log",
  http: "http",
  score: "internal",
  eval: "internal",
};

export function normalizeKind(kind: string | null | undefined): string | undefined {
  if (!kind) return undefined;
  const k = kind.trim().toLowerCase().replace(/^neatlogs\./, "");
  return KIND_ALIAS[k] ?? k;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function kv(key: string, value: unknown): KeyValue | null {
  if (value === undefined || value === null || value === "") return null;
  return { key, value: plainToAny(value) };
}

export function buildSpan(n: SpanNode): OtlpSpan {
  const kind = normalizeKind(n.kind) ?? (n.model ? "llm" : n.toolName ? "tool" : "chain");
  const startNs = toNs(n.start) ?? BigInt(Date.now()) * 1_000_000n;
  let endNs = toNs(n.end ?? undefined);
  if (endNs === undefined && n.durationMs !== undefined && n.durationMs !== null) endNs = startNs + BigInt(Math.round(n.durationMs * 1e6));
  if (endNs === undefined || endNs < startNs) endNs = startNs;
  const failed = !!n.error || (n.status ?? "").toString().toUpperCase() === "ERROR";
  const attrs: (KeyValue | null)[] = [kv("neatlogs.span.kind", kind), kv("neatlogs.session.id", n.sessionId), kv("neatlogs.user.id", n.userId)];
  if (kind === "llm") {
    attrs.push(
      kv("neatlogs.llm.model_name", n.model),
      kv("neatlogs.llm.provider", n.provider),
      kv("neatlogs.llm.token_count.prompt", n.promptTokens),
      kv("neatlogs.llm.token_count.completion", n.completionTokens),
      kv("neatlogs.llm.token_count.total", n.totalTokens ?? (n.promptTokens != null || n.completionTokens != null ? (n.promptTokens ?? 0) + (n.completionTokens ?? 0) : null)),
      kv("neatlogs.llm.input", text(n.input)),
      kv("neatlogs.llm.output", text(n.output)),
    );
  } else if (kind === "tool" || kind === "mcp_tool") {
    attrs.push(kv("neatlogs.tool.name", n.toolName ?? n.name), kv("neatlogs.tool.input", text(n.input)), kv("neatlogs.tool.output", text(n.output)));
  } else if (kind === "retriever") {
    attrs.push(kv("neatlogs.retriever.query", text(n.input)), kv("neatlogs.retriever.documents", text(n.output)));
  } else if (kind === "workflow" || kind === "agent") {
    attrs.push(kv(`neatlogs.${kind}.input`, text(n.input)), kv(`neatlogs.${kind}.output`, text(n.output)));
    if (kind === "agent") attrs.push(kv("neatlogs.agent.name", n.name));
  } else {
    attrs.push(kv("neatlogs.input.value", text(n.input)), kv("neatlogs.output.value", text(n.output)));
  }
  if (kind !== "llm" && n.model) attrs.push(kv("neatlogs.llm.model_name", n.model));
  for (const [k, v] of Object.entries(n.attributes ?? {})) attrs.push(kv(k, typeof v === "object" && v !== null ? JSON.stringify(v) : v));
  const events = (n.logs ?? []).map((l) => ({
    timeUnixNano: String(toNs(l.timestamp) ?? startNs),
    name: "log",
    attributes: [kv("log.severity", l.level ?? "info"), kv("log.message", l.message)].filter((x): x is KeyValue => !!x),
  }));
  if (n.error) {
    events.push({
      timeUnixNano: String(endNs),
      name: "exception",
      attributes: [kv("exception.message", n.error)].filter((x): x is KeyValue => !!x),
    });
  }
  return {
    traceId: hexId(n.traceId, 16),
    spanId: hexId(n.spanId, 8),
    parentSpanId: n.parentSpanId ? hexId(n.parentSpanId, 8) : "",
    name: n.name || kind,
    kind: kind === "llm" || kind === "http" ? 3 : 1,
    startTimeUnixNano: String(startNs),
    endTimeUnixNano: String(endNs),
    attributes: attrs.filter((x): x is KeyValue => !!x),
    events,
    links: [],
    status: failed ? { code: STATUS_ERROR, message: n.error ?? "error" } : { code: STATUS_OK },
  };
}

/**
 * Groups built spans into one batch per project. `source` marks where they came from
 * (neatroots.import.source), so imported runs can be told apart from live ones.
 */
export function toBatches(nodes: SpanNode[], opts: { project: string; source: string; extra?: Record<string, string> }): ResourceSpansBatch[] {
  if (!nodes.length) return [];
  const resource = {
    attributes: [
      { key: "service.name", value: { stringValue: opts.project } },
      { key: "neatlogs.workflow_name", value: { stringValue: opts.project } },
      { key: "neatroots.import.source", value: { stringValue: opts.source } },
      ...Object.entries(opts.extra ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
    ],
  };
  return [{ resource, scope: { name: `neatroots.import.${opts.source}` }, spans: nodes.map(buildSpan) }];
}
