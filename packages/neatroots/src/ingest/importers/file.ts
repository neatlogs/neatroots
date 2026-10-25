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
  if (Array.isArray(o.resourceSpans) || Array.isArray(o.resource_spans)) {
    // A collector dump has no import marker of its own; add one so retention treats it as imported.
    const batches = decodeTraceJson(o);
    for (const b of batches) {
      if (!b.resource.attributes.some((a) => a.key === "neatroots.import.source")) b.resource.attributes.push({ key: "neatroots.import.source", value: { stringValue: "file" } });
    }
    return batches;
  }
  const exp = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, unknown>;
  if (Array.isArray(exp.spans) && exp.trace && typeof exp.trace === "object") return fromNeatlogsExport(exp, project);
  if (typeof o.name === "string") return httpTraceToBatches(o, project, { stableIds: true }).batches;
  throw new ImportError("not OTLP JSON, a Neatlogs trace export or a Neatlogs HTTP trace");
}

function fromNeatlogsExport(exp: Record<string, unknown>, project: string): ResourceSpansBatch[] {
  const trace = exp.trace as { traceId: string; workflowName?: string; traceName?: string; sessionId?: string };
  const spans = exp.spans as Record<string, unknown>[];
  const ids = new Set(spans.map((s) => s.spanId));
  const nodes = spans.map<SpanNode>((s) => ({
    traceId: String(s.traceId ?? trace.traceId),
    spanId: String(s.spanId),
    parentSpanId: s.parentSpanId && ids.has(s.parentSpanId) ? String(s.parentSpanId) : null,
    name: String(s.spanName ?? "span"),
    kind: (s.spanType as string) ?? null,
    start: String(s.startedAt),
    end: (s.endedAt as string) ?? null,
    durationMs: (s.durationMs as number) ?? null,
    status: String(s.status ?? "OK").toUpperCase().startsWith("ERR") ? "ERROR" : "OK",
    model: (s.model as string) ?? null,
    provider: (s.provider as string) ?? null,
    promptTokens: (s.promptTokens as number) ?? null,
    completionTokens: (s.completionTokens as number) ?? null,
    totalTokens: (s.totalTokens as number) ?? null,
    input: s.input,
    output: s.output,
    sessionId: trace.sessionId ?? null,
  }));
  return toBatches(nodes, { project: trace.workflowName || trace.traceName || project, source: "file" });
}

/** Parses a file's text into batches. Throws ImportError naming the line that failed. */
export function parseTraceFile(text: string, name: string, project?: string): ResourceSpansBatch[] {
  const batches = readBatches(text, name, project ?? "imported");
  if (!batches.length) throw new ImportError(`${name} has no traces`);
  if (project) for (const b of batches) setProject(b, project);
  return batches;
}

/** An explicit project wins over the project named in the file. */
function setProject(b: ResourceSpansBatch, project: string): void {
  const rest = b.resource.attributes.filter((a) => a.key !== "service.name" && a.key !== "neatlogs.workflow_name");
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
