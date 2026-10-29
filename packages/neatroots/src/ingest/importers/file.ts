import { decodeTraceJson } from "../../otlp/codec.js";
import type { ResourceSpansBatch } from "../../otlp/types.js";
import { toBatches, type SpanNode } from "../build.js";
import { httpTraceToBatches } from "../http-trace.js";
import { ImportError } from "./types.js";

// Files people already have: OTLP JSON (an exporter's file output or a collector dump),
// Neatlogs Cloud trace exports, and Neatlogs HTTP trace trees. One document per file, or
// one per line (.jsonl / .ndjson).

function fromDoc(doc: unknown, project: string): ResourceSpansBatch[] {
  if (Array.isArray(doc)) return doc.flatMap((d) => fromDoc(d, project));
  if (!doc || typeof doc !== "object") throw new ImportError("expected a JSON object");
  const o = doc as Record<string, unknown>;
  if (Array.isArray(o.resourceSpans) || Array.isArray(o.resource_spans)) return decodeTraceJson(o);
  const exp = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, unknown>;
  if (Array.isArray(exp.spans) && exp.trace && typeof exp.trace === "object") return fromNeatlogsExport(exp, project);
  if (typeof o.name === "string") return httpTraceToBatches(o, project, { stableIds: true }).batches;
  throw new ImportError("not OTLP JSON, a Neatlogs trace export or a Neatlogs HTTP trace");
}

function fromNeatlogsExport(exp: Record<string, unknown>, project: string): ResourceSpansBatch[] {
  const trace = exp.trace as { traceId: string; workflowName?: string; traceName?: string; sessionId?: string };
  const spans = exp.spans as Record<string, unknown>[];
  const ids = new Set(spans.map((s) => s.spanId));
  const nodes = spans.map<SpanNode>((s) => {
    const err =
      typeof s.error === "string"
        ? s.error
        : s.error && typeof s.error === "object"
          ? String((s.error as { message?: unknown; value?: unknown }).message ?? (s.error as { value?: unknown }).value ?? "") || null
          : null;
    const isErr = String(s.status ?? "OK").toUpperCase().startsWith("ERR") || !!err;
    const kind = (s.spanType as string) ?? null;
    const name = String(s.spanName ?? "span");
    return {
      traceId: String(s.traceId ?? trace.traceId),
      spanId: String(s.spanId),
      parentSpanId: s.parentSpanId && ids.has(s.parentSpanId) ? String(s.parentSpanId) : null,
      name,
      kind,
      start: String(s.startedAt),
      end: (s.endedAt as string) ?? null,
      durationMs: (s.durationMs as number) ?? null,
      status: isErr ? "ERROR" : "OK",
      error: err || (isErr ? "error" : null),
      model: (s.model as string) ?? null,
      provider: (s.provider as string) ?? null,
      promptTokens: (s.promptTokens as number) ?? null,
      completionTokens: (s.completionTokens as number) ?? null,
      totalTokens: (s.totalTokens as number) ?? null,
      toolName: (s.toolName as string) ?? (kind && /tool/i.test(kind) ? name : null),
      input: s.input,
      output: s.output,
      sessionId: trace.sessionId ?? null,
    };
  });
  return toBatches(nodes, { project: trace.workflowName || trace.traceName || project, source: "file" });
}

const WORKFLOW_RESOURCE_KEYS = new Set(["service.name", "neatlogs.workflow_name", "neatlogs.workflow.name"]);
const WORKFLOW_SPAN_KEYS = new Set(["neatlogs.workflow_name", "neatlogs.workflow.name"]);

function hasNonEmptyStringValue(a: { value: Record<string, unknown> }): boolean {
  return "stringValue" in a.value && typeof a.value.stringValue === "string" && a.value.stringValue.length > 0;
}

function hasProjectAttribution(b: ResourceSpansBatch): boolean {
  return (
    b.resource.attributes.some((a) => WORKFLOW_RESOURCE_KEYS.has(a.key) && hasNonEmptyStringValue(a)) ||
    b.spans.some((s) => s.attributes.some((a) => WORKFLOW_SPAN_KEYS.has(a.key) && hasNonEmptyStringValue(a)))
  );
}

/** Parses a file's text into batches. Throws ImportError naming the line that failed. */
export function parseTraceFile(text: string, name: string, project?: string): ResourceSpansBatch[] {
  const batches = readBatches(text, name, project ?? "imported");
  if (!batches.length) throw new ImportError(`${name} has no traces`);
  for (const b of batches) {
    setImportSource(b, "file");
    if (project) setProject(b, project);
    else if (!hasProjectAttribution(b)) {
      setProject(b, "imported");
    }
  }
  return batches;
}

function hasImportProvenance(a: { key: string; value: Record<string, unknown> }): boolean {
  return (
    a.key === "neatroots.import.source" &&
    "stringValue" in a.value &&
    typeof a.value.stringValue === "string" &&
    a.value.stringValue.length > 0 &&
    a.value.stringValue !== "http" &&
    a.value.stringValue !== "replay"
  );
}

function setImportSource(b: ResourceSpansBatch, source: string): void {
  if (b.resource.attributes.some(hasImportProvenance)) return;
  const rest = b.resource.attributes.filter((a) => a.key !== "neatroots.import.source");
  b.resource.attributes = [...rest, { key: "neatroots.import.source", value: { stringValue: source } }];
}

/** An explicit project wins over the project named in the file. */
function setProject(b: ResourceSpansBatch, project: string): void {
  const rest = b.resource.attributes.filter((a) => !WORKFLOW_RESOURCE_KEYS.has(a.key));
  for (const span of b.spans) {
    span.attributes = span.attributes.filter((a) => !WORKFLOW_SPAN_KEYS.has(a.key));
  }
  b.resource.attributes = [{ key: "service.name", value: { stringValue: project } }, { key: "neatlogs.workflow_name", value: { stringValue: project } }, ...rest];
}

function readBatches(text: string, name: string, project: string): ResourceSpansBatch[] {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError(`${name} is empty`);
  const explicitLines = /\.(jsonl|ndjson)$/i.test(name);
  if (!explicitLines) {
    let doc: unknown;
    let parsed = false;
    try {
      doc = JSON.parse(trimmed);
      parsed = true;
    } catch (err) {
      if (trimmed.startsWith("[") || !trimmed.includes("\n{")) throw new ImportError(`${name}: ${(err as Error).message}`);
    }
    if (parsed) {
      try {
        return fromDoc(doc, project);
      } catch (err) {
        throw new ImportError(`${name}: ${(err as Error).message}`);
      }
    }
  }
  const out: ResourceSpansBatch[] = [];
  trimmed.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(...fromDoc(JSON.parse(line), project));
    } catch (err) {
      throw new ImportError(`${name} line ${i + 1}: ${(err as Error).message}`);
    }
  });
  return out;
}
