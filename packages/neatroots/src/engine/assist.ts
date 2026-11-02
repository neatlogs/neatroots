import type { Roots } from "../core.js";
import { AnyCheck, type QuestionCheck } from "../checks/types.js";
import { fitEvidence } from "../checks/lint.js";
import { ASK_SCHEMA, ASK_SYSTEM, CONCERN_SCHEMA, CONCERN_SYSTEM, wrapRun } from "./prompts.js";
import { buildEvidence, describeSpan, loadTrace, type SpanInfo } from "./trace.js";

const STOP = new Set(
  "a an the and or but if of to in on at by for with from is are was were be been being do does did have has had my our your their this that these those what which who whom why how when where it its as about into over than then so not no yes can could should would will just any all some".split(
    " ",
  ),
);

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "check"
  );
}

/** Turns a plain-language concern into a yes/no question check (not saved). */
export async function draftCheckFromConcern(roots: Roots, concern: string, opts: { workflow?: string; project?: string; signal?: AbortSignal } = {}): Promise<QuestionCheck> {
  const r = await roots.llm.chat(
    [
      { role: "system", content: CONCERN_SYSTEM },
      { role: "user", content: `Concern: ${concern}${opts.workflow ? `\nAgent workflow: ${opts.workflow}` : ""}` },
    ],
    { schema: { name: "check", schema: CONCERN_SCHEMA }, maxTokens: 300, priority: "interactive", signal: opts.signal },
  );
  const out = r.json as { id?: string; title?: string; ask?: string; scope?: string; span_type?: string; guidance?: string } | undefined;
  if (!out?.ask) throw new Error("the local LLM did not return a usable check");
  let id = slug(out.id || out.title || out.ask);
  for (let i = 2; roots.checks.get(id); i++) id = `${slug(out.id || out.title || out.ask)}-${i}`;
  const types = out.span_type === "llm" ? ["llm"] : out.span_type === "tool" ? ["tool", "mcp_tool"] : ["llm", "tool", "mcp_tool"];
  const check = {
    id,
    kind: "yes_no",
    title: out.title ?? out.ask.slice(0, 80),
    description: `Written from: ${concern}`,
    scope: out.scope === "span" ? "span" : out.scope === "session" ? "session" : "trace",
    ask: out.ask,
    evidence: { spans: { type: types }, fields: ["input", "output", "status", "error"], ...(out.scope === "span" ? {} : { last: 12 }) },
    flag_at: 0.8,
    ...(out.guidance ? { guidance: out.guidance } : {}),
    ...(opts.workflow ? { applies_to: { workflow: opts.workflow } } : opts.project ? { applies_to: { project: opts.project } } : {}),
  };
  return fitEvidence(AnyCheck.parse(check) as QuestionCheck);
}

export interface AskResult {
  answer: string;
  evidence: { trace_id: string; span_id: string; name: string }[];
  grounding: number | null;
  model: string;
  searched: number;
}

/** Answers a question over local runs, retrieving relevant spans instead of reading whole runs. */
export async function askRuns(roots: Roots, question: string, opts: { traceId?: string } = {}): Promise<AskResult> {
  const pool = new Map<string, { traceId: string; span: SpanInfo }>();
  let context: string;
  if (opts.traceId) {
    const snap = loadTrace(roots.store, opts.traceId);
    const ev = buildEvidence(snap, { fields: ["input", "output", "status", "error"], final_output: true }, { budget: 8000 });
    for (const s of snap.spans) pool.set(s.ref, { traceId: opts.traceId, span: s });
    context = `Run ${opts.traceId} (status ${snap.run?.status ?? "unknown"}):\n${ev.text}`;
  } else {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((t) => t.length > 2 && !STOP.has(t));
    const seen = new Set<string>();
    const hits: { trace_id: string; span_id: string }[] = [];
    for (const t of terms) {
      for (const h of roots.store.searchSpans(t, 15)) {
        const k = `${h.trace_id}:${h.span_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(h);
      }
    }
    const lines: string[] = [];
    const byTrace = new Map<string, string[]>();
    for (const h of hits.slice(0, 24)) {
      const list = byTrace.get(h.trace_id) ?? [];
      list.push(h.span_id);
      byTrace.set(h.trace_id, list);
    }
    if (!byTrace.size) {
      for (const r of roots.store.listRuns({ limit: 5 })) byTrace.set(r.trace_id, []);
    }
    for (const [traceId, spanIds] of byTrace) {
      const snap = loadTrace(roots.store, traceId);
      const spans = spanIds.length ? snap.spans.filter((s) => spanIds.includes(s.id)) : snap.spans.slice(-4);
      lines.push(`Run ${traceId.slice(0, 12)} (${snap.run?.workflow ?? "?"}, ${snap.run?.status ?? "?"}, started ${snap.run?.started_ms ? new Date(snap.run.started_ms).toISOString() : "?"}):`);
      for (const s of spans) {
        pool.set(s.ref, { traceId, span: s });
        lines.push(describeSpan(s, ["input", "output", "status", "error"], 400));
      }
    }
    context = lines.join("\n");
  }
  const r = await roots.llm.chat(
    [
      { role: "system", content: ASK_SYSTEM },
      { role: "user", content: `Question: ${question}\n\n${wrapRun(context)}` },
    ],
    { schema: { name: "answer", schema: ASK_SCHEMA }, maxTokens: 400, priority: "interactive" },
  );
  const out = r.json as { answer?: string; evidence?: string[] } | undefined;
  const evidence: AskResult["evidence"] = [];
  for (const ref of out?.evidence ?? []) {
    const k = String(ref).replace(/[[\]\s]/g, "").toLowerCase().slice(0, 6);
    const hit = pool.get(k);
    if (hit && !evidence.some((e) => e.span_id === hit.span.id)) evidence.push({ trace_id: hit.traceId, span_id: hit.span.id, name: hit.span.toolName ?? hit.span.name });
  }
  const grounding = roots.engine ? await roots.engine.grounding(context.slice(0, 6000), out?.answer ?? "") : null;
  return { answer: out?.answer ?? "I could not answer that from the local runs.", evidence, grounding, model: r.model, searched: pool.size };
}
