import type { RuleCheck } from "./types.js";
import { finalOutput, selectSpans, type SpanInfo, type TraceSnapshot } from "../engine/trace.js";
import { preview } from "../semantics/view.js";
import { log } from "../util/log.js";
import { testWithin } from "../util/regex.js";

/** How long one check's pattern may run on one span before it is treated as too slow. */
const MATCH_MS = 50;
/** Patterns that ran out of time; skipped from then on, so a bad check costs one short stall. */
const tooSlow = new Set<string>();
/** Results for patterns run under the time limit, per span, so a span is tested once per pattern. */
const matchMemo = new Map<string, boolean>();
const TIMED_OUT = Symbol("timed out");

export interface RuleHit {
  /** Whether the condition holds now, looking at the latest spans. */
  firing: boolean;
  evidenceSpanIds: string[];
  params: Record<string, string>;
  title?: string;
}

/** Object member order is not a change in arguments or results; array order still is. */
function jsonKey(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const object = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
}

function keyOf(s: SpanInfo, fields: string[]): string {
  return fields
    .map((f) => {
      if (f === "tool") return s.toolName ?? s.name;
      if (f === "name") return s.name;
      if (f === "input") return jsonKey(s.input);
      if (f === "output") return jsonKey(s.output);
      if (f === "status") return s.status;
      return "";
    })
    .join("\u0000");
}

/** Words an agent uses when it tells the user something went wrong. */
const ADMITS_FAILURE = /\b(fail(ed|s|ures?|ing)?|errors?|unable|couldn'?t|could not|can'?t|can ?not|unfortunately|sorry|apologi[sz]e|(didn'?t|did not|doesn'?t|does not|won'?t|will not) (go through|work|succeed)|(not|wasn'?t|weren'?t) (able|successful|completed)|try again|retry)\b/i;

/** Curly, modifier, backtick, and fullwidth apostrophes, as models often write "couldn’t". */
const APOSTROPHES = /[\u2018\u2019\u02BC\u0060\uFF07]/g;

/** "No errors", "0 failures", "weren't any failures", "no need to try again": the answer says nothing failed. */
const DENIES_FAILURE = /\b(?:no|zero|0|without(?: any)?|free of|(?:weren'?t|wasn'?t|were not|was not|never(?:\s+\w+)?)\s+any)\s+(?:\w+\s+)?(?:errors?|fail(?:ures?|ed)?|issues?|problems?)\b|\bno need to (?:try again|retry)\b/gi;

function clip(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Retries stay within the nearest agent; ordinary per-turn spans fall back to the run root. */
function recoveryScope(span: SpanInfo, byId: Map<string, SpanInfo>, rootId: string): string {
  const seen = new Set([span.id]);
  let parentId = span.parentId;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.kind === "AGENT") return parent.id;
    parentId = parent.parentId;
  }
  return rootId;
}

/** How much of a field a `match` rule reads, across all the texts it reads from it. */
const MATCH_CHARS = 200_000;

/**
 * The texts a `match` rule reads from a field: each text item of an MCP tool result, read like
 * a plain string output, then the field itself (as JSON when it isn't a string).
 * JSON.stringify escapes the quotes inside `content[].text`, so `"error":` there reads as
 * `\"error\":` and a pattern written for plain output would never see it. All texts share one
 * MATCH_CHARS budget, so the text items, which are the tool's real output, are read first.
 */
function matchTexts(v: unknown): string[] {
  const texts: string[] = [];
  let budget = MATCH_CHARS;
  const add = (text: string): void => {
    if (budget <= 0) return;
    const clipped = text.slice(0, budget);
    texts.push(clipped);
    budget -= clipped.length;
  };
  const content = v && typeof v === "object" && !Array.isArray(v) ? (v as { content?: unknown }).content : undefined;
  if (Array.isArray(content)) {
    for (const item of content) {
      const part = item && typeof item === "object" ? (item as { type?: unknown; text?: unknown }) : undefined;
      if (part?.type === "text" && typeof part.text === "string") add(part.text);
    }
  }
  add(typeof v === "string" ? v : JSON.stringify(v));
  return texts;
}

/**
 * Evaluates one rule against a trace. Returns null when the rule has never held in this
 * trace; otherwise `firing` says whether it still holds for the newest spans, which is how
 * a finding later resolves. `fresh` names the spans that just arrived: a streak they complete
 * fires even if a later span in the same batch already ended it.
 */
export function evaluateRule(check: RuleCheck, t: TraceSnapshot, atEnd: boolean, fresh?: ReadonlySet<string>, untrusted = false): RuleHit | null {
  const r = check.rule;
  switch (r.type) {
    case "repeat": {
      const spans = selectSpans(t.spans, r.span).sort((a, b) => a.endMs - b.endMs);
      if (spans.length < r.at_least) return null;
      const groups = new Map<string, SpanInfo[]>();
      for (const s of spans) {
        const k = keyOf(s, r.same);
        const g = groups.get(k) ?? [];
        g.push(s);
        groups.set(k, g);
      }
      let worst: SpanInfo[] | undefined;
      for (const g of groups.values()) if (g.length >= r.at_least && (!worst || g.length > worst.length)) worst = g;
      if (!worst) return null;
      const last = spans[spans.length - 1];
      const lastGroup = groups.get(keyOf(last, r.same))!;
      let now = lastGroup.length >= r.at_least ? lastGroup : undefined;
      if (!now && fresh) {
        for (const g of groups.values()) {
          const reached = g.length >= r.at_least && g.slice(r.at_least - 1).some((s) => fresh.has(s.id));
          if (reached && (!now || g.length > now.length)) now = g;
        }
      }
      const firing = !!now;
      const g = now ?? worst;
      const s0 = g[0];
      return {
        firing,
        evidenceSpanIds: g.map((s) => s.id),
        params: {
          tool: s0.toolName ?? s0.name,
          count: String(g.length),
          args: clip(preview(s0.input, 200)),
          result: clip(g[g.length - 1].error ?? preview(g[g.length - 1].output, 200)),
        },
      };
    }
    case "errors": {
      const spans = selectSpans(t.spans, r.span).sort((a, b) => a.endMs - b.endMs);
      let best: SpanInfo[] = [];
      let cur: SpanInfo[] = [];
      let reached: SpanInfo[] | undefined;
      for (const s of spans) {
        if (s.status === "error") {
          cur.push(s);
          if (cur.length > best.length) best = [...cur];
          if (cur.length >= r.consecutive && fresh?.has(s.id)) reached = [...cur];
        } else cur = [];
      }
      if (best.length < r.consecutive) return null;
      const firing = cur.length >= r.consecutive || !!reached;
      const g = cur.length >= r.consecutive ? cur : (reached ?? best);
      const last = g[g.length - 1];
      return {
        firing,
        evidenceSpanIds: g.map((s) => s.id),
        params: { tool: last.toolName ?? last.name, error: clip(last.error ?? "error", 200), count: String(g.length) },
      };
    }
    case "count": {
      const spans = selectSpans(t.spans, r.span);
      if (spans.length < r.at_least) return null;
      return { firing: true, evidenceSpanIds: spans.slice(-5).map((s) => s.id), params: { count: String(spans.length) } };
    }
    case "slow": {
      const slow = selectSpans(t.spans, r.span)
        .filter((s) => s.durationMs >= r.at_least_ms)
        .sort((a, b) => b.durationMs - a.durationMs);
      if (!slow.length) return null;
      const top = slow[0];
      return {
        firing: true,
        evidenceSpanIds: slow.slice(0, 5).map((s) => s.id),
        params: {
          tool: top.toolName ?? top.name,
          ms: String(Math.round(top.durationMs)),
          limit_ms: String(r.at_least_ms),
          count: String(slow.length),
        },
      };
    }
    case "threshold": {
      const run = t.run;
      if (!run) return null;
      const value =
        r.metric === "duration_ms"
          ? (run.ended_ms ?? run.last_span_ms ?? 0) - (run.started_ms ?? 0)
          : r.metric === "span_count"
            ? run.span_count
            : Number(run[r.metric] ?? 0);
      if (value < r.at_least) return null;
      return { firing: true, evidenceSpanIds: [], params: { value: String(Math.round(value)), metric: r.metric } };
    }
    case "match": {
      const key = `${r.flags ?? "i"}/${r.pattern}`;
      if (untrusted && tooSlow.has(key)) return null;
      let re: RegExp;
      try {
        re = new RegExp(r.pattern, r.flags ?? "i");
      } catch {
        return null;
      }
      // Library patterns are known to be fast. Patterns from checks people (or coding agents) write
      // run under a time limit, since a regex can backtrack for minutes and stall the server.
      const test = (text: string): boolean => {
        re.lastIndex = 0;
        if (!untrusted) return re.test(text);
        const ok = testWithin(re, text, MATCH_MS);
        if (ok === undefined) throw TIMED_OUT;
        return ok;
      };
      let hits: SpanInfo[];
      try {
        hits = selectSpans(t.spans, r.span).filter((s) => {
          const v =
            r.field === "input"
              ? s.input
              : r.field === "output"
                ? s.output
                : r.field === "error"
                  ? s.error
                  : r.field === "finish_reason"
                    ? s.finishReason
                    : s.name;
          if (v === undefined || v === null) return false;
          const texts = matchTexts(v);
          if (!untrusted) return texts.some(test);
          const memo = `${key}\u0000${t.run?.trace_id ?? ""}\u0000${s.id}\u0000${r.field}\u0000${texts.reduce((n, x) => n + x.length, 0)}\u0000${r.field === "finish_reason" ? jsonKey(v) : ""}`;
          const known = matchMemo.get(memo);
          if (known !== undefined) return known;
          const found = texts.some(test);
          if (matchMemo.size >= 50_000) matchMemo.clear();
          matchMemo.set(memo, found);
          return found;
        });
      } catch (e) {
        if (e !== TIMED_OUT) throw e;
        tooSlow.add(key);
        log.warn(`check ${check.id}: its pattern took over ${MATCH_MS} ms on one span, so it is skipped until neatroots restarts. Simplify the regex (overlapping alternatives in a repeat, like (a|aa)+, are slow).`);
        return null;
      }
      if (!hits.length) return null;
      return { firing: true, evidenceSpanIds: hits.map((s) => s.id), params: { count: String(hits.length), span: hits[0].ref } };
    }
    case "requires_before": {
      const guarded = selectSpans(t.spans, r.span).sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
      if (!guarded.length) return null;
      // Instrumented spans that succeed usually report status unset, so only errors are ruled out.
      const needed = selectSpans(t.spans, { ...r.requires, status: "any" }).filter((s) => s.status !== "error");
      const missed = guarded.filter((g) => !needed.some((n) => n.id !== g.id && n.startMs <= g.startMs));
      // Spans can arrive out of order: once a late prerequisite covers every call, say so,
      // so a finding raised before it arrived resolves.
      if (!missed.length) return { firing: false, evidenceSpanIds: guarded.map((s) => s.id), params: {} };
      const first = missed[0];
      return {
        firing: true,
        evidenceSpanIds: missed.map((s) => s.id),
        params: {
          tool: first.toolName ?? first.name,
          requires: String(r.requires.tool ?? r.requires.name ?? r.requires.type ?? "the required step"),
          count: String(missed.length),
        },
      };
    }
    case "unrecovered_error": {
      // Only meaningful once the run is over: until then the agent may still retry.
      if (!atEnd || !t.run) return null;
      // A run that failed or was cut short is already reported by run-failed.
      if (t.run.status === "error" || t.run.interrupted) return null;
      const out = finalOutput(t);
      if (!out || /^("?\s*"?|null|\{\}|\[\])$/.test(out.trim())) return null;
      // An answer that says something failed is the agent being honest, not a problem.
      if (ADMITS_FAILURE.test(out.replace(APOSTROPHES, "'").replace(DENIES_FAILURE, " "))) return null;
      const spans = selectSpans(t.spans, r.span ?? { type: ["tool", "mcp_tool"] }).sort((a, b) => a.endMs - b.endMs || a.seq - b.seq);
      // Per-turn spans often change between retries. Scope by the nearest agent-kind ancestor,
      // falling back to the root for traces without one; malformed parent links also fall back safely.
      const byId = new Map(t.spans.map((s) => [s.id, s]));
      const rootId = t.spans.find((s) => s.parentId === null)?.id ?? t.traceId;
      const last = new Map<string, SpanInfo>();
      for (const s of spans) last.set(JSON.stringify([recoveryScope(s, byId, rootId), s.toolName ?? s.name]), s);
      const failed = [...last.values()].filter((s) => s.status === "error");
      if (!failed.length) return null;
      const first = failed[0];
      return {
        firing: true,
        evidenceSpanIds: failed.map((s) => s.id),
        params: {
          tool: first.toolName ?? first.name,
          // Only worth showing when more than one tool stayed failed.
          ...(failed.length > 1 ? { tools: failed.map((s) => s.toolName ?? s.name).join(", "), count: String(failed.length) } : {}),
          error: clip(first.error ?? "error", 200),
        },
      };
    }
    case "growth": {
      const spans = selectSpans(t.spans, r.span)
        .filter((s) => (s.tokens ?? 0) > 0)
        .sort((a, b) => a.endMs - b.endMs);
      if (spans.length < r.min_calls) return null;
      const first = spans[0].tokens!;
      const last = spans[spans.length - 1].tokens!;
      let up = 0;
      for (let i = 1; i < spans.length; i++) if (spans[i].tokens! > spans[i - 1].tokens!) up++;
      if (up / (spans.length - 1) < r.rising || last < first * r.factor || last < r.min_tokens) return null;
      return {
        firing: true,
        evidenceSpanIds: [spans[0].id, spans[spans.length - 1].id],
        params: { count: String(spans.length), first: String(first), last: String(last) },
      };
    }
    case "cycle": {
      const spans = selectSpans(t.spans, r.span).sort((a, b) => a.endMs - b.endMs);
      const names = spans.map((s) => s.toolName ?? s.name);
      const outs = spans.map((s) => jsonKey(s.output));
      // Stretches of the call list that are one short pattern repeated with no new results, found
      // in one pass per period. One still holds if it reaches the newest call or a fresh span
      // completed it; otherwise the newest stretch is reported as one the agent broke out of.
      let best: { start: number; end: number; p: number; firing: boolean } | undefined;
      for (let p = 2; p <= r.max_period; p++) {
        let start = 0;
        for (let end = p; end <= spans.length; end++) {
          if (end < spans.length && names[end] === names[end - p] && outs[end] === outs[end - p]) continue;
          // spans[start, end) repeat with period p; the next stretch can begin p - 1 calls back.
          const from = start;
          start = end - p + 1;
          if (end - from < p * r.min_cycles || new Set(names.slice(from, from + p)).size < 2) continue;
          const firing = end === spans.length || (!!fresh && spans.slice(from + p * r.min_cycles - 1, end).some((s) => fresh.has(s.id)));
          if (!best || (firing && !best.firing) || (firing === best.firing && end > best.end)) best = { start: from, end, p, firing };
        }
      }
      if (!best) return null;
      const { start, end, p } = best;
      return {
        firing: best.firing,
        evidenceSpanIds: spans.slice(start, end).map((s) => s.id),
        params: { pattern: names.slice(start, start + p).join(" -> "), count: String(Math.floor((end - start) / p)) },
      };
    }
    case "run_end": {
      if (!atEnd || !t.run) return null;
      const root = t.spans.find((s) => !s.parentId);
      if (r.when === "error" && t.run.status === "error") {
        return { firing: true, evidenceSpanIds: root ? [root.id] : [], params: { error: clip(root?.error ?? "error", 200) } };
      }
      if (r.when === "interrupted" && t.run.interrupted) {
        return { firing: true, evidenceSpanIds: root ? [root.id] : [], params: { reason: t.run.termination_reason ?? "interrupted" } };
      }
      if (r.when === "no_output" && root) {
        const out = finalOutput(t);
        const empty = !out || /^("?\s*"?|null|\{\}|\[\])$/.test(out.trim());
        if (empty && t.run.status !== "error") return { firing: true, evidenceSpanIds: [root.id], params: {} };
      }
      return null;
    }
  }
}

/** Fills {placeholders} from a finding's params; unknown placeholders are removed. */
export function fillTemplate(template: string, params: Record<string, string>): string {
  // Values go in through private-use markers so the empty-"()" cleanup below only touches
  // the template's own text: "({args})" with no args drops the parens, but an args value
  // like "print()" keeps its own.
  const values: string[] = [];
  return template
    // [[optional text with {param}]] stays only when every placeholder in it has a value.
    .replace(/\[\[([^\]]*)\]\]/g, (_, seg: string) => ([...seg.matchAll(/\{(\w+)\}/g)].every((m) => params[m[1]]?.trim()) ? seg : ""))
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = params[k] !== undefined ? params[k] : "";
      if (!v.trim()) return v;
      values.push(v);
      return `\uE000${values.length - 1}\uE001`;
    })
    .replace(/\(\s*\)/g, "")
    .replace(/\uE000(\d+)\uE001/g, (m, i: string) => values[Number(i)] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
