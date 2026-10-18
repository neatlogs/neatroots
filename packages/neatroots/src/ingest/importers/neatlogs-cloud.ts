import { toBatches, type SpanNode } from "../build.js";
import { getJson, iso, trimSlash, ImportError, type ImportSource } from "./types.js";

// Neatlogs Cloud Public API (app.neatlogs.com/api/v1/public), read with a service-account token
// (nlsa_…) as Authorization: Bearer, and x-project-id naming the project when the account sees
// several. The project API key that sends runs can't read them. A trace comes from
// /traces/{id}/export (trace and spans) plus each span's input, output and error from
// /spans/{id}/payload.

/** How imports authenticate: the token, and the project to read from. */
export interface CloudAuth {
  token: string;
  projectId?: string;
}

export interface CloudProject {
  id: string;
  name: string;
  orgId?: string;
  isDefault?: boolean;
  isArchived?: boolean;
}

export interface CloudTraceSummary {
  traceId: string;
  traceName?: string | null;
  workflowName?: string | null;
  sessionId?: string | null;
  startedAt: string;
  durationMs?: number | null;
  status?: string | null;
  spansCount?: number | null;
  llmCallsCount?: number | null;
  toolCallsCount?: number | null;
  totalTokens?: number | null;
}

interface CloudSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  spanType: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  status: string;
  model: string | null;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface Field {
  available: boolean;
  value: string | null;
  truncated?: boolean;
}

/** The public API's host for an ingest endpoint: ingest.neatlogs.com → app.neatlogs.com. */
export function cloudApiBase(ingest: string, override?: string): string {
  if (override) return trimSlash(override);
  try {
    const u = new URL(ingest);
    if (u.hostname.endsWith("neatlogs.com")) u.hostname = u.hostname.replace(/(^|\.)ingest\./, "$1app.");
    return `${u.origin}/api/v1/public`;
  } catch {
    return "https://app.neatlogs.com/api/v1/public";
  }
}

const headers = (a: CloudAuth): Record<string, string> => ({
  authorization: `Bearer ${a.token}`,
  accept: "application/json",
  ...(a.projectId ? { "x-project-id": a.projectId } : {}),
});

/** A refused credential gets a sentence about what to fix instead of the raw problem+json. */
async function cloudJson<T>(url: string, init: RequestInit & { signal: AbortSignal }): Promise<T> {
  try {
    return await getJson<T>(url, { ...init, redirect: "manual" });
  } catch (e) {
    const m = (e as Error).message;
    if (/ answered 401\b/.test(m)) throw new ImportError(`Neatlogs Cloud didn't accept the service-account token (401). Check it in Settings → Neatlogs Cloud; the project API key that sends runs can't read them.`);
    if (/ answered 3\d\d\b/.test(m)) throw new ImportError(`${new URL(url).host} redirected; neatroots doesn't follow redirects with the service-account token, so set the API base to the final URL`);
    if (/ answered 403\b/.test(m)) throw new ImportError(`The service-account token can't read that Neatlogs Cloud project (403). Pick a project it has access to in Settings → Neatlogs Cloud.`);
    throw e;
  }
}

/** Projects the service account can read, for choosing which one imports come from. */
export async function listCloudProjects(base: string, token: string, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<CloudProject[]> {
  const out: CloudProject[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const r = await cloudJson<{ data: { projects: CloudProject[]; page: { nextCursor: string | null; hasMore: boolean } } }>(`${base}/projects?${q}`, { headers: headers({ token }), signal });
    out.push(...r.data.projects.filter((p) => !p.isArchived));
    cursor = r.data.page.hasMore ? (r.data.page.nextCursor ?? undefined) : undefined;
  } while (cursor && out.length < 1000);
  return out;
}

export async function listCloudTraces(
  base: string,
  auth: CloudAuth,
  opts: { limit?: number; cursor?: string; sinceMs?: number; untilMs?: number; workflowName?: string; signal?: AbortSignal } = {},
): Promise<{ traces: CloudTraceSummary[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(Math.min(50, opts.limit ?? 50)) });
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.sinceMs) q.set("from", iso(opts.sinceMs));
  if (opts.untilMs) q.set("to", iso(opts.untilMs));
  if (opts.workflowName) q.set("workflowName", opts.workflowName);
  const r = await cloudJson<{ data: { traces: CloudTraceSummary[]; page: { nextCursor: string | null; hasMore: boolean } } }>(`${base}/traces?${q}`, {
    headers: headers(auth),
    signal: opts.signal ?? AbortSignal.timeout(30_000),
  });
  return { traces: r.data.traces, nextCursor: r.data.page.hasMore ? r.data.page.nextCursor : null };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** One cloud trace as span nodes, payloads included. */
export async function fetchCloudTrace(base: string, auth: CloudAuth, traceId: string, signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<{ nodes: SpanNode[]; workflow: string }> {
  const id = encodeURIComponent(traceId);
  const exp = await cloudJson<{ data: { trace?: CloudTraceSummary & { tags?: string[] }; spans?: CloudSpan[] } }>(`${base}/traces/${id}/export?format=json`, { headers: headers(auth), signal });
  const trace = exp.data.trace;
  const spans = exp.data.spans;
  if (!trace || !Array.isArray(spans)) throw new ImportError("Neatlogs Cloud did not return the trace's spans");
  const payloads = await pool(spans, 4, (s) =>
    cloudJson<{ data: { fields: { input?: Field; output?: Field; error?: Field } } }>(`${base}/traces/${id}/spans/${encodeURIComponent(s.spanId)}/payload?fields=input,output,error`, {
      headers: headers(auth),
      signal,
    })
      .then((r) => r.data.fields)
      .catch(() => ({}) as { input?: Field; output?: Field; error?: Field }),
  );
  const ids = new Set(spans.map((s) => s.spanId));
  const nodes = spans.map<SpanNode>((s, i) => {
    const f = payloads[i] ?? {};
    const err = f.error?.available ? f.error.value : null;
    return {
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null,
      name: s.spanName,
      kind: s.spanType,
      start: s.startedAt,
      end: s.endedAt,
      durationMs: s.durationMs,
      status: s.status?.toUpperCase().startsWith("ERR") ? "ERROR" : "OK",
      error: err || (s.status?.toUpperCase().startsWith("ERR") ? "error" : null),
      input: f.input?.available ? f.input.value : undefined,
      output: f.output?.available ? f.output.value : undefined,
      model: s.model,
      provider: s.provider,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: s.totalTokens,
      toolName: /tool/i.test(s.spanType) ? s.spanName : null,
      sessionId: trace.sessionId ?? null,
      attributes: { "neatroots.import.cloud_trace_id": traceId },
    };
  });
  return { nodes, workflow: trace.workflowName || trace.traceName || "neatlogs-cloud" };
}

/** An import stops when this many traces in a row fail to download: the cloud is down, not one trace. */
const CLOUD_FAILURES_IN_A_ROW = 3;

export const NO_CLOUD_TOKEN = "importing from Neatlogs Cloud needs a service-account token (nlsa_…): add it in Settings → Neatlogs Cloud, or run neatroots cloud token";

/** Built by the import runner with the stored service-account token, project and API base. */
export function neatlogsCloudSource(base: () => string, auth: () => Promise<CloudAuth | undefined>): ImportSource {
  return {
    id: "neatlogs-cloud",
    label: "Neatlogs Cloud",
    description: "Traces from your Neatlogs Cloud project, read with a service-account token (neatroots cloud token).",
    fields: [{ name: "traceIds", label: "Trace ids (comma-separated; empty imports the most recent)", placeholder: "4bf92f35…" }],
    async *traces(o) {
      const k = await auth();
      if (!k) throw new ImportError(NO_CLOUD_TOKEN);
      const b = base();
      let ids = (o.values.traceIds ?? "").split(/[\s,]+/).filter(Boolean);
      if (!ids.length) {
        let cursor: string | undefined;
        do {
          const page = await listCloudTraces(b, k, { cursor, sinceMs: o.sinceMs, untilMs: o.untilMs, signal: o.signal });
          ids.push(...page.traces.map((t) => t.traceId));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && ids.length < o.limit);
        ids = ids.slice(0, o.limit);
      }
      let failedInARow = 0;
      for (const id of ids) {
        let read: { nodes: SpanNode[]; workflow: string };
        try {
          read = await fetchCloudTrace(b, k, id, o.signal);
          failedInARow = 0;
        } catch (err) {
          // One trace that won't download shouldn't stop the rest. A cancel, or a token or
          // permission problem (which would fail every trace the same way), still ends the import,
          // and so do a few failures in a row: then the cloud itself is down, and waiting out each
          // trace's timeout would keep the import running for hours.
          const message = (err as Error).message;
          if (o.signal.aborted || /\((401|403)\)/.test(message)) throw err;
          yield { sourceId: id, batches: [], error: message };
          if (++failedInARow >= CLOUD_FAILURES_IN_A_ROW) throw new ImportError(`stopped after ${failedInARow} traces in a row failed to download; the last: ${message}`);
          continue;
        }
        yield { sourceId: id, batches: toBatches(read.nodes, { project: o.project || read.workflow, source: "neatlogs-cloud" }) };
      }
    },
  };
}
