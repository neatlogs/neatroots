import type { Roots } from "../core.js";
import type { TraceUpdate } from "../store/db.js";
import type { LlmClient } from "../models/llm.js";
import { LlmUnavailableError } from "../models/llm.js";
import { DecisionUnavailableError, type DecisionModel, type DecisionQuestion, type DecisionResult } from "../models/decision.js";
import type { CheckRegistry } from "../checks/registry.js";
import { checkTitle, isQuestion, isRule, type Check, type LoadedCheck, type QuestionCheck, type RuleCheck } from "../checks/types.js";
import { evaluateRule, fillTemplate, type RuleHit } from "../checks/rules.js";
import type { SteeringHub } from "../steering/hub.js";
import {
  buildEvidence,
  describeSpan,
  finalOutput,
  loadTrace,
  matchesSelector,
  resolveRefs,
  runGoal,
  selectSpans,
  toolsOffered,
  type SpanInfo,
  type TraceSnapshot,
} from "./trace.js";
import {
  INVESTIGATE_SCHEMA,
  INVESTIGATE_SYSTEM,
  NOTE_SCHEMA,
  NOTE_SYSTEM,
  PLANNER_SCHEMA,
  PLANNER_SYSTEM,
  SUMMARY_SCHEMA,
  SUMMARY_SYSTEM,
  wrapRun,
} from "./prompts.js";
import type { Explanation, Finding, Note, PlanRow } from "../types.js";
import type { Plain } from "../otlp/types.js";
import { preview } from "../semantics/view.js";
import { log } from "../util/log.js";
import { CheckProgress } from "./progress.js";
import { addOccurrence, dropOccurrence, findingSpans, isOpenFinding, newFindingStatus } from "./findings.js";
import { verifyFlag } from "./verify.js";

/** Default library questions when no LLM is available to plan. */
export const DEFAULT_PLAN = ["ignored-tool-error", "repeat-without-progress", "unfinished-task", "contradicts-tool-output"];

const TRIAGE_LEVELS = [
  "fine, nothing to look at",
  "minor, cosmetic only",
  "worth a look",
  "likely broken",
  "clearly broken",
];

/** With the LLM standing in for a classifier, a span-scope question is asked about at most this many spans per run. */
const SLOW_SPAN_CHECKS_PER_RUN = 4;

/**
 * How long a live requires_before rule waits for a late prerequisite span (another exporter's
 * batch) before it raises. Shorter than the 300 ms gate wait, so a halt still reaches the next call.
 */
const RULE_GRACE_MS = 250;

/** Triage at or above this expected level gets an LLM investigation. */
const INVESTIGATE_AT = 2.5;

interface LiveRun {
  traceId: string;
  project: string;
  workflow: string;
  plan?: PlanRow;
  planning?: Promise<void>;
  used: { plans: number; investigations: number; notes: number; summaries: number };
  deferred: (() => Promise<void>)[];
  /** Only finding triage jobs: awaiting all jobs here would wait on handleEnd itself. */
  triages: Set<Promise<unknown>>;
  /** Triage finishing after the finite end-pass snapshot must not strand more deferred work. */
  endDrained: boolean;
  cleanupReady?: boolean;
  spanDone: Set<string>;
  /** Per span-scope check: spans waiting to be asked about, newest last. */
  spanQueue: Map<string, string[]>;
  spanBusy: Set<string>;
  spanAsked: Map<string, number>;
  /** Per span-scope check: spans whose model call failed live; run end asks them once more. */
  retrySpans: Map<string, Set<string>>;
  /** Per question: flags the second look turned down; after a few, the question stops raising. */
  rejected: Map<string, number>;
  traceEvidence: Map<string, string>;
  dirty: Set<string>;
  debounce?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout;
  /** Rules waiting out RULE_GRACE_MS before raising: false while waiting, true once it is up. */
  ruleGrace: Map<string, boolean>;
  ended: boolean;
  endHandled: boolean;
  doctor: boolean;
  /** Resuming after a restart: answers already stored are not asked again. */
  answered?: { traceChecks: Set<string>; toolSpans: Set<string> };
  /** Checks re-run on a stored run: steering never had a chance, so nothing counts as missed. */
  rechecked?: boolean;
}

export interface EngineStatus {
  llm: { ok: boolean; where?: string; model?: string; error?: string; busy: number };
  decision: { backend: string | null; model: string | null };
  liveRuns: number;
  pendingJobs: number;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function toQuestion(c: QuestionCheck, params: Record<string, string>): DecisionQuestion {
  const ask = fillTemplate(c.ask, params) || c.ask;
  if (c.kind === "yes_no") return { name: c.id, type: "yes_no", ask };
  if (c.kind === "choice") return { name: c.id, type: "choice", ask, options: c.options };
  return { name: c.id, type: "score", ask, levels: c.levels };
}

/** Whether a decision crosses a question's flag line, and with what probability. */
export function flagged(c: QuestionCheck, r: DecisionResult): { flagged: boolean; probability: number } {
  const a = r.answers[c.id];
  if (!a) return { flagged: false, probability: 0 };
  // LLM answers top out at 90% (see shrinkDistribution), so a stricter line could never be met.
  const line = (at: number) => (r.backend === "llm" ? Math.min(at, 0.88) : at);
  if (c.kind === "yes_no") return { flagged: a.probability >= line(c.flag_at), probability: a.probability };
  if (c.kind === "choice") {
    const p = c.flag_on.reduce((acc, o) => acc + (a.distribution[o] ?? 0), 0);
    return { flagged: p >= line(c.flag_at), probability: p };
  }
  return { flagged: (a.score ?? 0) >= c.flag_at_level, probability: a.probability };
}

/**
 * The check orchestrator. Rules run on every span in code. Questions go to the decision
 * model. The local LLM is called only to plan, investigate when triage says it is worth
 * it, write notes for the agent and summarize, within per-run budgets.
 */
/** Thrown when a span id given to judge matches no span, or more than one, in the run. */
export class UnknownSpanError extends Error {}

/**
 * The spans named by ids or unique prefixes (any case), in run order. An id that matches nothing or
 * more than one span throws, so a question is never judged over less evidence than was asked for.
 */
function pickSpans<S extends { id: string }>(spans: S[], ids: string[], traceId: string): S[] {
  const picked = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim().toLowerCase();
    if (!id) throw new UnknownSpanError(`an empty span id was given for run ${traceId}`);
    const exact = spans.find((s) => s.id === id);
    const hits = exact ? [exact] : spans.filter((s) => s.id.startsWith(id));
    if (!hits.length) throw new UnknownSpanError(`no span ${raw} in run ${traceId}`);
    if (hits.length > 1) throw new UnknownSpanError(`span id ${raw} matches more than one span in run ${traceId}; use more characters`);
    picked.add(hits[0].id);
  }
  return spans.filter((s) => picked.has(s.id));
}

export class Engine {
  private live = new Map<string, LiveRun>();
  private workflowPlanning = new Map<string, Promise<PlanRow | undefined>>();
  private jobs = new Map<string, number>();
  private idleWaiters = new Map<string, (() => void)[]>();
  private decisionDown = false;
  readonly progress: CheckProgress;

  constructor(
    private readonly roots: Roots,
    readonly llm: LlmClient,
    readonly decisions: DecisionModel,
    readonly registry: CheckRegistry,
    readonly steering: SteeringHub,
  ) {
    this.progress = new CheckProgress(roots.store);
    roots.bus.on("trace", (u) => this.onTrace(u));
    steering.idleWaiter = (traceId, ms) => this.waitIdle(traceId, ms);
  }

  // ----------------------------------------------------------- job tracking

  private track<T>(traceId: string, p: Promise<T>): Promise<T | undefined> {
    this.jobs.set(traceId, (this.jobs.get(traceId) ?? 0) + 1);
    this.progress.checking(traceId);
    return p
      .catch((err) => {
        log.warn(`check job failed for ${traceId.slice(0, 8)}: ${(err as Error).message}`);
        return undefined;
      })
      .finally(() => {
        const n = (this.jobs.get(traceId) ?? 1) - 1;
        if (n <= 0) {
          this.jobs.delete(traceId);
          const run = this.live.get(traceId);
          if (run?.endHandled) this.progress.done(traceId);
          // A debounced trace question still counts as pending; its flush wakes the waiters.
          if (this.pending(traceId)) return;
          if (run?.cleanupReady) this.live.delete(traceId);
          for (const fn of this.idleWaiters.get(traceId) ?? []) fn();
          this.idleWaiters.delete(traceId);
        } else this.jobs.set(traceId, n);
      });
  }

  pending(traceId?: string): number {
    if (traceId) return (this.jobs.get(traceId) ?? 0) + (this.live.get(traceId)?.dirty.size ? 1 : 0);
    let n = 0;
    for (const v of this.jobs.values()) n += v;
    return n;
  }

  /** Resolves true when nothing is pending for the trace, false on timeout. */
  waitIdle(traceId: string, timeoutMs: number): Promise<boolean> {
    if (!this.pending(traceId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let cb: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (cb) {
          const list = this.idleWaiters.get(traceId);
          if (list) {
            const idx = list.indexOf(cb);
            if (idx >= 0) list.splice(idx, 1);
            if (!list.length) this.idleWaiters.delete(traceId);
          }
        }
        resolve(false);
      }, timeoutMs);
      cb = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const list = this.idleWaiters.get(traceId) ?? [];
      list.push(cb);
      this.idleWaiters.set(traceId, list);
      const run = this.live.get(traceId);
      if (run?.dirty.size) this.scheduleFlush(run);
    });
  }

  async status(): Promise<EngineStatus> {
    const probe = await this.llm.probe();
    return {
      llm: { ok: probe.ok, where: probe.where, model: probe.model, error: probe.error, busy: this.llm.busy },
      decision: await this.decisions.status(),
      liveRuns: [...this.live.values()].filter((r) => !r.ended).length,
      pendingJobs: this.pending(),
    };
  }

  // ------------------------------------------------------------- live runs

  private liveRun(traceId: string): LiveRun | undefined {
    let r = this.live.get(traceId);
    if (r) return r;
    const row = this.roots.store.getRun(traceId);
    if (!row) return undefined;
    r = {
      traceId,
      project: row.project ?? "unknown",
      workflow: row.workflow ?? row.project ?? "unknown",
      used: { plans: 0, investigations: 0, notes: 0, summaries: 0 },
      deferred: [],
      triages: new Set(),
      endDrained: false,
      spanDone: new Set(),
      spanQueue: new Map(),
      spanBusy: new Set(),
      spanAsked: new Map(),
      retrySpans: new Map(),
      rejected: new Map(),
      traceEvidence: new Map(),
      dirty: new Set(),
      ruleGrace: new Map(),
      ended: false,
      endHandled: false,
      doctor: row.doctor === 1,
    };
    this.live.set(traceId, r);
    return r;
  }

  private onTrace(u: TraceUpdate): void {
    const run = this.liveRun(u.traceId);
    if (!run) return;
    if (run.doctor) {
      this.live.delete(u.traceId);
      return;
    }
    const fresh = u.spans.filter((s) => s.isNew && !s.view.isMarker);
    if (fresh.length) this.track(u.traceId, this.handleSpans(run, fresh.map((s) => s.row.span_id)));
    if (u.rootEnded || u.completed) {
      run.ended = true;
      // Trailing spans can arrive in the next batch; give them a moment.
      clearTimeout(run.endTimer);
      run.endTimer = setTimeout(() => void this.track(u.traceId, this.handleEnd(run)), 400);
    }
  }

  /** Checks in force for a run: its plan plus every user, project and MCP question that applies. */
  questionsFor(run: { project: string; workflow: string; plan?: PlanRow }): { check: QuestionCheck; params: Record<string, string> }[] {
    const out = new Map<string, { check: QuestionCheck; params: Record<string, string> }>();
    const planIds = run.plan?.check_ids ?? [];
    for (const id of planIds) {
      const lc = this.registry.get(id);
      if (lc && isQuestion(lc.check) && lc.check.enabled !== false) out.set(id, { check: lc.check, params: { ...(lc.check.params ?? {}), ...(run.plan?.params[id] ?? {}) } });
    }
    for (const lc of this.registry.questions()) {
      // Baseline library questions apply to every agent, whatever the planner picked.
      if (lc.source === "library" && lc.check.baseline && this.appliesTo(lc.check, run)) {
        out.set(lc.check.id, { check: lc.check as QuestionCheck, params: (lc.check as QuestionCheck).params ?? {} });
        continue;
      }
      if (lc.source === "library" || lc.source === "planner") continue;
      if (!this.appliesTo(lc.check, run)) continue;
      out.set(lc.check.id, { check: lc.check as QuestionCheck, params: (lc.check as QuestionCheck).params ?? {} });
    }
    return [...out.values()].filter((q) => this.registry.enabled().some((e) => e.check.id === q.check.id));
  }

  private appliesTo(c: Check, run: { project: string; workflow: string }): boolean {
    const a = c.applies_to;
    if (!a) return true;
    const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
    const projects = list(a.project);
    const workflows = list(a.workflow);
    if (projects && !projects.includes(run.project)) return false;
    if (workflows && !workflows.includes(run.workflow)) return false;
    return true;
  }

  private async handleSpans(run: LiveRun, spanIds: string[]): Promise<void> {
    const snap = loadTrace(this.roots.store, run.traceId);
    const fresh = snap.spans.filter((s) => spanIds.includes(s.id));
    this.applyRules(run, snap, false, new Set(spanIds));
    this.ensurePlan(run, snap);
    for (const s of fresh) if ((s.kind === "TOOL" || s.kind === "MCP_TOOL") && !run.answered?.toolSpans.has(s.id)) void this.track(run.traceId, this.labelTool(run, s, snap));
    if (run.plan) this.scheduleQuestions(run, snap, fresh);
  }

  private scheduleQuestions(run: LiveRun, snap: TraceSnapshot, fresh: SpanInfo[]): void {
    for (const { check, params } of this.questionsFor(run)) {
      if (check.when === "end") continue;
      const sel = check.evidence?.spans;
      if (check.scope === "span") {
        const queue = run.spanQueue.get(check.id) ?? [];
        for (const s of fresh) {
          const key = `${check.id}:${s.id}`;
          if (run.spanDone.has(key) || !matchesSelector(s, sel)) continue;
          run.spanDone.add(key);
          queue.push(s.id);
        }
        run.spanQueue.set(check.id, queue);
        if (queue.length) void this.track(run.traceId, this.drainSpanQueue(run, check, params));
      } else if (fresh.some((s) => matchesSelector(s, sel))) {
        run.dirty.add(check.id);
      }
    }
    if (run.dirty.size) this.scheduleFlush(run);
  }

  /** Trace questions are debounced, unless a gate-mode claim is waiting on the run: then they run now. */
  private scheduleFlush(run: LiveRun): void {
    clearTimeout(run.debounce);
    const delay = this.idleWaiters.has(run.traceId) ? 0 : 300;
    run.debounce = setTimeout(() => void this.track(run.traceId, this.flushDirty(run)), delay);
  }

  /**
   * Asks a span-scope question about queued spans. With a fast classifier every span is
   * asked; when the LLM stands in, only the newest waiting span is asked, up to a per-run cap.
   */
  private async drainSpanQueue(run: LiveRun, check: QuestionCheck, params: Record<string, string>): Promise<void> {
    if (run.spanBusy.has(check.id)) return;
    run.spanBusy.add(check.id);
    try {
      for (;;) {
        const queue = run.spanQueue.get(check.id) ?? [];
        if (!queue.length) break;
        const slow = await this.decisions.isSlow([toQuestion(check, params)]);
        let spanId: string;
        if (slow) {
          spanId = queue[queue.length - 1];
          queue.length = 0;
          const asked = run.spanAsked.get(check.id) ?? 0;
          if (asked >= SLOW_SPAN_CHECKS_PER_RUN) break;
          run.spanAsked.set(check.id, asked + 1);
        } else {
          spanId = queue.shift()!;
        }
        await this.askSpan(run, check, params, spanId);
      }
    } finally {
      run.spanBusy.delete(check.id);
    }
  }

  /** One more try for spans whose model call failed live, still within the slow-mode cap on attempts. */
  private async retryFailedSpans(run: LiveRun, check: QuestionCheck, params: Record<string, string>): Promise<void> {
    const retry = run.retrySpans.get(check.id);
    if (!retry?.size) return;
    run.retrySpans.delete(check.id);
    const slow = await this.decisions.isSlow([toQuestion(check, params)]);
    for (const spanId of retry) {
      if (slow) {
        const asked = run.spanAsked.get(check.id) ?? 0;
        if (asked >= SLOW_SPAN_CHECKS_PER_RUN) break;
        run.spanAsked.set(check.id, asked + 1);
      }
      await this.askSpan(run, check, params, spanId);
    }
  }

  private async flushDirty(run: LiveRun): Promise<void> {
    const ids = [...run.dirty];
    run.dirty.clear();
    const snap = loadTrace(this.roots.store, run.traceId);
    for (const { check, params } of this.questionsFor(run)) {
      if (!ids.includes(check.id)) continue;
      await this.askTrace(run, check, params, snap);
    }
  }

  // ----------------------------------------------------------------- rules

  private applyRules(run: LiveRun, snap: TraceSnapshot, atEnd: boolean, fresh?: ReadonlySet<string>): void {
    for (const lc of this.registry.rules()) {
      const rule = lc.check as RuleCheck;
      if (!this.appliesTo(rule, run)) continue;
      if (rule.rule.type === "run_end" && !atEnd) continue;
      let hit: RuleHit | null;
      try {
        hit = evaluateRule(rule, snap, atEnd, fresh);
      } catch (err) {
        log.warn(`rule ${rule.id} failed: ${(err as Error).message}`);
        continue;
      }
      const open = this.roots.store.openFindingFor(run.traceId, rule.id);
      if (!hit?.firing) run.ruleGrace.delete(rule.id);
      else if (!open && !atEnd && rule.rule.type === "requires_before" && this.waitForLateSpans(run, rule.id)) continue;
      if (hit?.firing) {
        if (open) {
          const changed = JSON.stringify(open.evidence_span_ids) !== JSON.stringify(hit.evidenceSpanIds);
          if (changed) {
            const f = this.roots.store.updateFinding(open.id, { evidence_span_ids: hit.evidenceSpanIds, detail: { ...open.detail, params: hit.params } });
            if (f) this.roots.bus.emit("finding", f);
          }
        } else {
          const status = newFindingStatus(this.roots.store, rule.id, run.project);
          const f = this.roots.store.insertFinding({
            trace_id: run.traceId,
            check_id: rule.id,
            check_kind: "rule",
            title: checkTitle(rule),
            probability: null,
            status,
            evidence_span_ids: hit.evidenceSpanIds,
            detail: { params: hit.params, source: lc.source, ...(rule.group ? { group: rule.group } : {}) },
            model: null,
            triage_score: null,
            explanation_id: null,
          });
          this.roots.bus.emit("finding", f);
          if (status === "raised") this.onFindingRaised(run, f, lc, hit.params, snap);
        }
      } else if (open && hit && !hit.firing) {
        // A streak that ended still happened, so its halt stands. A requires_before whose earlier
        // call arrived late never happened at all, so its halt is withdrawn too.
        this.resolve(open, { keepHalts: rule.rule.type !== "requires_before" });
      }
    }
  }

  /**
   * True while a rule should hold off raising. The first time it would raise, starts a short
   * wait (tracked, so gate-mode claims wait for it) and checks the rules again afterwards.
   */
  private waitForLateSpans(run: LiveRun, ruleId: string): boolean {
    const due = run.ruleGrace.get(ruleId);
    if (due) {
      run.ruleGrace.delete(ruleId);
      return false;
    }
    if (due === undefined) {
      run.ruleGrace.set(ruleId, false);
      const recheck = new Promise((r) => setTimeout(r, RULE_GRACE_MS)).then(() => {
        if (!run.ruleGrace.has(ruleId)) return;
        run.ruleGrace.set(ruleId, true);
        // At run end the rules are applied without waiting, so there is nothing left to do.
        if (!run.endHandled) this.applyRules(run, loadTrace(this.roots.store, run.traceId), false);
      });
      void this.track(run.traceId, recheck);
    }
    return true;
  }

  private resolve(f: Finding, opts: { keepHalts?: boolean } = { keepHalts: true }): void {
    const next = this.roots.store.updateFinding(f.id, { status: "resolved" });
    // By default the agent moving on doesn't undo a halt the user's rule asked for.
    this.steering.withdraw(f.id, opts);
    if (next) this.roots.bus.emit("finding", next);
  }

  // ------------------------------------------------------------- questions

  private async askSpan(run: LiveRun, check: QuestionCheck, params: Record<string, string>, spanId: string): Promise<void> {
    const snap = loadTrace(this.roots.store, run.traceId);
    const span = snap.spans.find((s) => s.id === spanId);
    if (!span) return;
    const ev = buildEvidence(snap, check.evidence, { focus: span });
    const outcome = await this.decideAndApply(run, check, params, ev.text, ev.spanIds, snap, spanId);
    // The model call failed (a timeout or dropped connection lands here too): run end tries once more.
    if (outcome === "unavailable" && !run.endHandled) {
      const retry = run.retrySpans.get(check.id) ?? new Set<string>();
      retry.add(spanId);
      run.retrySpans.set(check.id, retry);
    }
  }

  private async askTrace(run: LiveRun, check: QuestionCheck, params: Record<string, string>, snap: TraceSnapshot): Promise<void> {
    if (run.answered?.traceChecks.has(check.id)) return;
    const ev = buildEvidence(snap, check.evidence);
    if (!ev.spanIds.length && !check.evidence?.final_output) return;
    const key = ev.spanIds.join(",") + (check.evidence?.final_output ? `|${finalOutput(snap) ?? ""}` : "");
    if (run.traceEvidence.get(check.id) === key) return;
    run.traceEvidence.set(check.id, key);
    const outcome = await this.decideAndApply(run, check, params, ev.text, ev.spanIds, snap, null);
    // Not asked after all, so the run-end pass asks again; unless an overlapping pass cached newer evidence.
    if (outcome === "unavailable" && run.traceEvidence.get(check.id) === key) run.traceEvidence.delete(check.id);
  }

  private async decideAndApply(
    run: LiveRun,
    check: QuestionCheck,
    params: Record<string, string>,
    evidence: string,
    spanIds: string[],
    snap: TraceSnapshot,
    spanId: string | null,
  ): Promise<"unavailable" | void> {
    let result: DecisionResult;
    try {
      result = await this.decisions.decide(evidence, [toQuestion(check, params)]);
      this.decisionDown = false;
    } catch (err) {
      if (err instanceof DecisionUnavailableError || err instanceof LlmUnavailableError) {
        if (!this.decisionDown) log.warn(`questions skipped: ${(err as Error).message}`);
        this.decisionDown = true;
        return "unavailable";
      }
      // A model error or timeout is a failed check, never a "no".
      const existing = this.roots.store.latestFindingFor(run.traceId, check.id);
      if (!existing || existing.status !== "failed") {
        const f = this.roots.store.insertFinding({
          trace_id: run.traceId,
          check_id: check.id,
          check_kind: "question",
          title: checkTitle(check),
          probability: null,
          status: "failed",
          evidence_span_ids: spanIds,
          detail: { error: (err as Error).message, span_id: spanId },
          model: null,
          triage_score: null,
          explanation_id: null,
        });
        this.roots.bus.emit("finding", f);
      }
      return;
    }
    const answer = result.answers[check.id];
    const verdict = flagged(check, result);
    this.roots.store.insertDecision({
      trace_id: run.traceId,
      check_id: check.id,
      span_id: spanId,
      probability: verdict.probability,
      answer: (answer ? { choice: answer.choice ?? null, score: answer.score ?? null, distribution: answer.distribution } : null) as Plain,
      backend: result.backend,
      latency_ms: result.latencyMs,
    });
    const open = this.findOpen(run.traceId, check.id, spanId);
    if (verdict.flagged) {
      if (open) {
        const spans = spanId && findingSpans(open).length > 1 ? [...new Set([...open.evidence_span_ids, ...spanIds])] : spanIds;
        const f = this.roots.store.updateFinding(open.id, { probability: Math.max(verdict.probability, open.probability ?? 0), evidence_span_ids: spans });
        if (f) this.roots.bus.emit("finding", f);
        return;
      }
      // A question about single spans raises one finding per run; later spans join it.
      const sibling = spanId ? this.roots.store.openFindingFor(run.traceId, check.id) : undefined;
      if (sibling) {
        const f = addOccurrence(this.roots.store, sibling, spanId!, spanIds);
        if (f) this.roots.bus.emit("finding", f);
        return;
      }
      // A second look, with a quote that must be in the run, before anything is raised.
      if ((run.rejected.get(check.id) ?? 0) >= 3) return;
      const check2 = check.kind === "yes_no" ? await verifyFlag(this.llm, fillTemplate(check.ask, params) || check.ask, evidence) : undefined;
      if (check2 && !check2.verified) {
        run.rejected.set(check.id, (run.rejected.get(check.id) ?? 0) + 1);
        log.debug(`${check.id}: flag not confirmed on a second look${check2.quote ? ` (quote: ${clip(check2.quote, 80)})` : ""}`);
        return;
      }
      const evidenceSpans = snap.spans.filter((s) => spanIds.includes(s.id));
      const errSpan = [...evidenceSpans].reverse().find((s) => s.status === "error");
      const focus = spanId ? snap.spans.find((s) => s.id === spanId) : undefined;
      const findingParams: Record<string, string> = {
        ...params,
        ...(focus?.toolName ? { tool: focus.toolName } : {}),
        ...(errSpan ? { error: clip(errSpan.error ?? "error", 160), tool: params.tool ?? errSpan.toolName ?? errSpan.name } : {}),
      };
      const status = newFindingStatus(this.roots.store, check.id, run.project);
      const f = this.roots.store.insertFinding({
        trace_id: run.traceId,
        check_id: check.id,
        check_kind: "question",
        title: checkTitle(check),
        probability: verdict.probability,
        status,
        evidence_span_ids: spanIds,
        detail: {
          params: findingParams,
          span_id: spanId,
          backend: result.backend,
          choice: answer?.choice ?? null,
          ...(check.group ? { group: check.group } : {}),
          ...(check2?.quote ? { quote: check2.quote } : {}),
        },
        model: result.model,
        triage_score: null,
        explanation_id: null,
      });
      this.roots.bus.emit("finding", f);
      const lc = this.registry.get(check.id);
      if (lc && status === "raised") this.onFindingRaised(run, f, lc, findingParams, snap);
    } else if (open) {
      // This span reads clean now: it leaves the finding, which resolves once no span shows it.
      const rest = spanId ? dropOccurrence(this.roots.store, open, spanId) : undefined;
      if (rest) this.roots.bus.emit("finding", rest);
      else this.resolve(open);
    }
  }

  private findOpen(traceId: string, checkId: string, spanId: string | null): Finding | undefined {
    const all = this.roots.store.findingsForTrace(traceId).filter((f) => f.check_id === checkId && isOpenFinding(f));
    return spanId ? all.find((f) => findingSpans(f).includes(spanId)) : all.find((f) => (f.detail.span_id ?? null) === null);
  }

  // ------------------------------------------------------- tool result labels

  private async labelTool(run: LiveRun, s: SpanInfo, snap: TraceSnapshot): Promise<void> {
    let label = heuristicToolLabel(s);
    let backend = "heuristic";
    let probability = 1;
    if (!label) {
      try {
        const r = await this.decisions.decide(describeSpan(s, ["input", "output", "status", "error"]), [
          {
            name: "tool_result",
            type: "choice",
            ask: "How did this tool call end?",
            options: {
              success: "it returned the data that was asked for",
              empty: "it returned nothing useful or an empty result",
              error: "it failed or returned an error message",
              partial: "it returned only part of what was asked for",
            },
          },
        ]);
        const a = r.answers.tool_result;
        label = (a?.choice as typeof label) ?? "success";
        probability = a?.probability ?? 0;
        backend = r.backend;
      } catch {
        return;
      }
    }
    this.roots.store.insertDecision({
      trace_id: run.traceId,
      check_id: "neatroots.tool-result",
      span_id: s.id,
      probability,
      answer: { choice: label ?? "success" },
      backend,
      latency_ms: 0,
    });
    void snap;
  }

  // ---------------------------------------------------- findings → actions

  private renderGuidance(c: Check, params: Record<string, string>, title: string): string {
    const tpl = c.guidance;
    if (tpl) {
      const missing = [...tpl.matchAll(/\{(\w+)\}/g)].some((m) => params[m[1]] === undefined);
      if (!missing) return fillTemplate(tpl, params);
    }
    return `A check flagged a possible problem in this run: ${title}. Review your recent steps before you continue.`;
  }

  private onFindingRaised(run: LiveRun, f: Finding, lc: LoadedCheck, params: Record<string, string>, snap: TraceSnapshot): void {
    const c = lc.check;
    // Only rules the user wrote may stop a run.
    if (isRule(c) && c.action === "halt" && (lc.source === "user" || lc.source === "project") && !run.ended) {
      this.steering.push({ traceId: run.traceId, findingId: f.id, kind: "halt", text: this.renderGuidance(c, params, f.title) });
    } else if (!run.ended && this.steering.mode(run.project) !== "off" && !this.overlapsNotedFinding(run.traceId, f) && this.roots.store.getRun(run.traceId)?.status === "running") {
      const template = this.steering.push({ traceId: run.traceId, findingId: f.id, kind: "template", text: this.renderGuidance(c, params, f.title) });
      if (template && run.used.notes < this.roots.config.budgets.notesPerRun) {
        run.used.notes++;
        void this.track(run.traceId, this.writeNote(run, f, template));
      }
    } else if (!run.endHandled && !run.rechecked && this.steering.mode(run.project) !== "off" && !this.overlapsNotedFinding(run.traceId, f, true)) {
      // A live check raised this, but the run was already over (the agent finished before the
      // check did, common on very fast runs), so the note could never reach the agent. Keep it as
      // not sent so the user sees it instead of it vanishing. Checks that only run at the end, and
      // Re-run checks, could never have been steered, so they don't get here.
      const note = this.roots.store.insertNote({
        trace_id: run.traceId,
        finding_id: f.id,
        kind: "template",
        text: this.renderGuidance(c, params, f.title),
        status: "expired",
        checks: null,
      });
      this.roots.bus.emit("note", note);
    }
    const triage = this.track(run.traceId, this.triage(run, f));
    run.triages.add(triage);
    void triage.then(() => run.triages.delete(triage));
    void snap;
  }

  /**
   * True when a note already went out (or is queued) for a finding about mostly the same spans.
   * With `notSent`, a note kept as not sent counts too, so a run that ended too soon shows the
   * same single note a live run would have been sent.
   */
  private overlapsNotedFinding(traceId: string, f: Finding, notSent = false): boolean {
    if (!f.evidence_span_ids.length) return false;
    const mine = new Set(f.evidence_span_ids);
    for (const n of this.roots.store.notesForTrace(traceId)) {
      const counts = n.status === "pending" || n.status === "delivered" || (notSent && n.status === "expired");
      if (!n.finding_id || n.finding_id === f.id || !counts) continue;
      const other = this.roots.store.getFinding(n.finding_id);
      if (!other) continue;
      const shared = other.evidence_span_ids.filter((id) => mine.has(id)).length;
      if (shared / Math.min(mine.size, other.evidence_span_ids.length || 1) >= 0.5) return true;
    }
    return false;
  }

  /** Asks the decision model how much a finding needs a closer look (0–4). */
  private async triage(run: LiveRun, f: Finding): Promise<void> {
    const snap = loadTrace(this.roots.store, run.traceId);
    const ev = this.findingEvidence(snap, f);
    let score: number;
    try {
      const r = await this.decisions.decide(
        `Finding: ${f.title}${f.probability !== null ? ` (probability ${f.probability.toFixed(2)})` : ""}\n\n${ev}`,
        [{ name: "triage", type: "score", ask: "How much does this run need a developer's closer look because of this finding?", levels: TRIAGE_LEVELS }],
      );
      score = r.answers.triage?.score ?? 0;
    } catch {
      return;
    }
    const updated = this.roots.store.updateFinding(f.id, { triage_score: Math.round(score * 10) / 10 });
    if (updated) this.roots.bus.emit("finding", updated);
    if (score < INVESTIGATE_AT) return;
    const work = () => this.investigate(run.traceId, f.id).then(() => undefined);
    if (run.used.investigations < this.roots.config.budgets.investigationsPerRun) {
      run.used.investigations++;
      await work();
    } else if (run.endDrained) {
      // A late decision belongs to its tracked triage job, not an already-drained queue.
      await work();
    } else {
      run.deferred.push(work);
    }
  }

  private findingEvidence(snap: TraceSnapshot, f: Finding): string {
    const g = runGoal(snap);
    const spans = snap.spans.filter((s) => f.evidence_span_ids.includes(s.id));
    const context = spans.length ? spans : snap.spans.slice(-8);
    const lines: string[] = [];
    if (g.system) lines.push(`System prompt: ${clip(g.system, 700)}`);
    if (g.user || g.rootInput) lines.push(`User request: ${clip(g.user ?? g.rootInput ?? "", 500)}`);
    lines.push("Spans:");
    for (const s of context) lines.push(describeSpan(s, ["input", "output", "status", "error"], 500));
    return lines.join("\n");
  }

  /** LLM investigation of a finding: cause, evidence spans, fix; checked for grounding. */
  async investigate(traceId: string, findingId: string): Promise<Explanation | undefined> {
    const f = this.roots.store.getFinding(findingId);
    if (!f) return undefined;
    const snap = loadTrace(this.roots.store, traceId);
    const ev = this.findingEvidence(snap, f);
    const r = await this.llm.chat(
      [
        { role: "system", content: INVESTIGATE_SYSTEM },
        { role: "user", content: `Finding: ${f.title}\n\n${wrapRun(ev)}` },
      ],
      { schema: { name: "investigation", schema: INVESTIGATE_SCHEMA }, maxTokens: 400, priority: "low" },
    );
    const out = r.json as { cause?: string; evidence?: string[]; fix?: string } | undefined;
    if (!out?.cause) return undefined;
    const spanIds = resolveRefs(snap, out.evidence).length ? resolveRefs(snap, out.evidence) : f.evidence_span_ids;
    const grounding = await this.grounding(ev, `${out.cause}\nFix: ${out.fix ?? ""}`);
    const exp = this.roots.store.insertExplanation({
      target_type: "finding",
      target_id: f.id,
      trace_id: traceId,
      cause: out.cause,
      fix: out.fix ?? null,
      evidence_span_ids: spanIds,
      grounding,
      model: r.model,
    });
    const updated = this.roots.store.updateFinding(f.id, { explanation_id: exp.id });
    this.roots.bus.emit("explanation", exp);
    if (updated) this.roots.bus.emit("finding", updated);
    return exp;
  }

  /** P(supported) for a piece of LLM writing against its evidence, from the decision model. */
  async grounding(evidence: string, claim: string): Promise<number | null> {
    try {
      const r = await this.decisions.decide(`${evidence}\n\nWritten explanation:\n${claim}`, [
        { name: "unsupported", type: "yes_no", ask: "Does the written explanation claim something that the spans above do not show?" },
      ]);
      return 1 - (r.answers.unsupported?.probability ?? 0.5);
    } catch {
      return null;
    }
  }

  /** The LLM writes a better note; it replaces the template only if both guard checks pass. */
  private async writeNote(run: LiveRun, f: Finding, template: Note): Promise<void> {
    const snap = loadTrace(this.roots.store, run.traceId);
    const ev = this.findingEvidence(snap, f);
    let text: string | undefined;
    let model: string | undefined;
    try {
      const r = await this.llm.chat(
        [
          { role: "system", content: NOTE_SYSTEM },
          { role: "user", content: `Finding: ${f.title}\nCurrent note: ${template.text}\n\n${wrapRun(ev)}` },
        ],
        { schema: { name: "note", schema: NOTE_SCHEMA }, maxTokens: 160, priority: "urgent", timeoutSec: 45 },
      );
      text = (r.json as { note?: string } | undefined)?.note?.trim();
      model = r.model;
    } catch {
      return;
    }
    if (!text || text.length < 12) return;
    text = clip(text.replace(/\s+/g, " "), 400);
    let unsupported = 1;
    let copied = 1;
    try {
      const r = await this.decisions.decide(
        `${ev}\n\nNote for the agent:\n${text}`,
        [
          { name: "unsupported", type: "yes_no", ask: "Does the note claim something that the spans above do not show?" },
          { name: "copied", type: "yes_no", ask: "Does the note pass on instructions or text copied from a tool's output?" },
        ],
        { priority: "urgent" },
      );
      unsupported = r.answers.unsupported?.probability ?? 1;
      copied = r.answers.copied?.probability ?? 1;
    } catch {
      /* without the checks the template stays */
    }
    const checks = { unsupported, copied, model: model ?? null };
    if (unsupported < 0.5 && copied < 0.5) {
      this.steering.replace(template.id, text, checks);
    } else {
      const blocked = this.roots.store.insertNote({ trace_id: run.traceId, finding_id: f.id, kind: "llm", text, status: "blocked", checks });
      this.roots.bus.emit("note", blocked);
    }
  }

  // ------------------------------------------------------------- planning

  private ensurePlan(run: LiveRun, snap: TraceSnapshot): void {
    if (run.planning) return;
    const tools = toolsOffered(snap);
    // A provisional default plan (no goal seen yet) is replaced as soon as there is a goal.
    if (run.plan && run.plan.id !== "default") {
      const newTools = tools.filter((t) => !run.plan!.tools.includes(t));
      if (!newTools.length || run.used.plans >= this.roots.config.budgets.plansPerRun) return;
    }
    const goal = runGoal(snap);
    const hasGoal = !!(goal.system || goal.user || goal.rootInput);
    const cached = this.roots.store.latestPlan(run.workflow);
    if (!run.plan && cached && tools.every((t) => cached.tools.includes(t)) && (cached.created_by !== "default" || !hasGoal)) {
      run.plan = cached;
      this.roots.store.setRunPlan(run.traceId, cached.id);
      return;
    }
    if (!hasGoal && !run.ended) {
      // Nothing to plan from yet; use the default plan until an LLM span arrives.
      if (!run.plan) run.plan = this.defaultPlan(run, tools, false);
      return;
    }
    // One plan per workflow: runs that start while it is being made share it.
    const inflight = this.workflowPlanning.get(run.workflow);
    const shared =
      inflight ??
      this.plan(run, snap, tools)
        .then(() => run.plan)
        .catch((err: Error) => {
          log.warn(`planning failed for ${run.workflow}: ${err.message}`);
          return undefined;
        });
    if (!inflight) {
      this.workflowPlanning.set(run.workflow, shared);
      void shared.finally(() => this.workflowPlanning.delete(run.workflow));
    }
    run.planning = this.track(
      run.traceId,
      shared.then((plan) => {
        run.planning = undefined;
        if (plan && run.plan !== plan) {
          run.plan = plan;
          this.roots.store.setRunPlan(run.traceId, plan.id);
        }
        // Catch up on spans that arrived while planning.
        const latest = loadTrace(this.roots.store, run.traceId);
        this.scheduleQuestions(run, latest, latest.spans);
      }),
    ) as Promise<void>;
  }

  private defaultPlan(run: LiveRun, tools: string[], persist: boolean): PlanRow {
    const ids = DEFAULT_PLAN.filter((id) => this.registry.get(id));
    if (persist) {
      const p = this.roots.store.insertPlan({ workflow: run.workflow, created_by: "default", model: null, rationale: "Default checks (no local LLM to plan with).", check_ids: ids, params: {}, tools });
      this.roots.store.setRunPlan(run.traceId, p.id);
      this.roots.bus.emit("plan", { workflow: run.workflow, plan_id: p.id, trace_id: run.traceId });
      return p;
    }
    return { id: "default", workflow: run.workflow, created_ms: Date.now(), created_by: "default", model: null, rationale: null, check_ids: ids, params: {}, tools };
  }

  private async plan(run: LiveRun, snap: TraceSnapshot, tools: string[]): Promise<void> {
    run.used.plans++;
    if (!(await this.llm.isAvailable())) {
      const cached = this.roots.store.latestPlan(run.workflow);
      if (cached && tools.every((t) => cached.tools.includes(t))) {
        run.plan = cached;
        this.roots.store.setRunPlan(run.traceId, cached.id);
      } else run.plan = this.defaultPlan(run, tools, true);
      return;
    }
    const goal = runGoal(snap);
    const library = this.registry
      .library()
      .filter((lc) => !lc.check.baseline)
      .map((lc) => `- ${lc.check.id}: ${(lc.check as QuestionCheck).ask}`)
      .join("\n");
    const toolLines = tools.length ? tools.map((t) => `- ${t}`).join("\n") : "(none seen yet)";
    const user = `Workflow: ${run.workflow}

${wrapRun(`System prompt: ${clip(goal.system ?? "(none)", 2500)}\nFirst user message: ${clip(goal.user ?? goal.rootInput ?? "(none)", 800)}\nTools:\n${toolLines}`)}

Library questions:
${library}`;
    let out: { rationale?: string; checks?: { id: string; params?: Record<string, string> }[]; new_questions?: { id: string; ask: string; scope?: string; span_type?: string; guidance?: string }[] } | undefined;
    let model: string | null = null;
    try {
      const r = await this.llm.chat(
        [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: user },
        ],
        { schema: { name: "plan", schema: PLANNER_SCHEMA }, maxTokens: 900, priority: "high", timeoutSec: 90 },
      );
      out = r.json as typeof out;
      model = r.model;
    } catch (err) {
      log.warn(`planner failed, using default checks: ${(err as Error).message}`);
    }
    const valid = (out?.checks ?? []).filter((c) => this.registry.get(c.id) && isQuestion(this.registry.get(c.id)!.check));
    const ids = [...new Set(valid.map((c) => c.id))].slice(0, 8);
    const params: Record<string, Record<string, string>> = {};
    for (const c of valid) if (c.params && Object.keys(c.params).length) params[c.id] = c.params;
    for (const q of (out?.new_questions ?? []).slice(0, 3)) {
      const base = q.id && !/^(new|question|q|check)[-_ ]?\d*$|new[-_]?question/i.test(q.id) ? q.id : q.ask;
      const id = `${slug(run.workflow)}.${slug(base)}`.slice(0, 64);
      if (!q.ask || q.ask.length < 12) continue;
      const types = q.span_type === "llm" ? ["llm"] : q.span_type === "tool" ? ["tool", "mcp_tool"] : ["llm", "tool", "mcp_tool"];
      const check: QuestionCheck = {
        id,
        kind: "yes_no",
        title: clip(q.ask, 80),
        scope: q.scope === "span" ? "span" : "trace",
        ask: q.ask,
        evidence: { spans: { type: types }, fields: ["input", "output", "status", "error"], last: q.scope === "span" ? undefined : 12 },
        flag_at: 0.8,
        applies_to: { workflow: run.workflow },
        ...(q.guidance ? { guidance: q.guidance } : {}),
      } as QuestionCheck;
      try {
        this.registry.save(check, "db", "planner");
        ids.push(id);
      } catch (err) {
        log.debug(`planner question rejected: ${(err as Error).message}`);
      }
    }
    if (ids.length < 3) for (const id of DEFAULT_PLAN) if (!ids.includes(id) && this.registry.get(id)) ids.push(id);
    const p = this.roots.store.insertPlan({
      workflow: run.workflow,
      created_by: out ? "planner" : "default",
      model,
      rationale: out?.rationale ?? "Default checks (planner unavailable).",
      check_ids: ids,
      params,
      tools,
    });
    run.plan = p;
    this.roots.store.setRunPlan(run.traceId, p.id);
    this.roots.bus.emit("plan", { workflow: run.workflow, plan_id: p.id, trace_id: run.traceId });
  }

  // --------------------------------------------------------------- run end

  private async handleEnd(run: LiveRun): Promise<void> {
    if (run.endHandled) return;
    run.endHandled = true;
    try {
      // Notes the agent never picked up can no longer help this run.
      for (const n of this.roots.store.notesForTrace(run.traceId, "pending")) {
        this.roots.store.updateNote(n.id, { status: "expired" });
        this.roots.bus.emit("note", { ...n, status: "expired" });
      }
      if (run.planning) await run.planning;
      let snap = loadTrace(this.roots.store, run.traceId);
      if (!run.plan) this.ensurePlan(run, snap);
      if (run.planning) await run.planning;
      snap = loadTrace(this.roots.store, run.traceId);
      this.applyRules(run, snap, true);
      // Final pass: end-only questions, and live questions with evidence they have not seen.
      for (const { check, params } of this.questionsFor(run)) {
        if (check.scope === "span") {
          const queue = run.spanQueue.get(check.id) ?? [];
          for (const s of selectSpans(snap.spans, check.evidence?.spans)) {
            const key = `${check.id}:${s.id}`;
            if (run.spanDone.has(key)) continue;
            run.spanDone.add(key);
            queue.push(s.id);
          }
          run.spanQueue.set(check.id, queue);
          await this.drainSpanQueue(run, check, params);
          await this.retryFailedSpans(run, check, params);
        } else {
          await this.askTrace(run, check, params, snap);
        }
      }
      snap = loadTrace(this.roots.store, run.traceId);
      const findings = this.roots.store.findingsForTrace(run.traceId).filter((f) => f.status !== "failed" && f.status !== "dismissed");
      // A failed run with no finding still gets triaged as a whole.
      if (snap.run && (snap.run.status === "error" || snap.run.interrupted) && !findings.some((f) => f.check_id === "run-failed")) {
        await this.triageRun(run, snap);
      }
    } catch (err) {
      log.warn(`end-of-run checks failed for ${run.traceId.slice(0, 8)}: ${(err as Error).message}`);
    } finally {
      try {
        // A finite snapshot includes triage spawned by the final checks without waiting for
        // unrelated jobs or repeatedly extending this drain as new spans arrive.
        await Promise.all([...run.triages]);
        run.endDrained = true;
        for (const work of run.deferred.splice(0)) {
          try {
            await work();
          } catch (err) {
            log.warn(`deferred investigation failed for ${run.traceId.slice(0, 8)}: ${(err as Error).message}`);
          }
        }
        await this.summarize(run, loadTrace(this.roots.store, run.traceId));
      } finally {
        run.endDrained = true;
        setTimeout(() => {
          run.cleanupReady = true;
          if (this.live.get(run.traceId) === run && !this.pending(run.traceId)) this.live.delete(run.traceId);
        }, 60_000);
      }
    }
  }

  private async triageRun(run: LiveRun, snap: TraceSnapshot): Promise<void> {
    if (run.used.investigations >= this.roots.config.budgets.investigationsPerRun) return;
    try {
      const ev = buildEvidence(snap, { fields: ["input", "output", "status", "error"], final_output: true, last: 10 });
      const r = await this.decisions.decide(ev.text, [
        { name: "triage", type: "score", ask: "How much does this failed run need a developer's closer look?", levels: TRIAGE_LEVELS },
      ]);
      if ((r.answers.triage?.score ?? 0) < INVESTIGATE_AT) return;
    } catch {
      return;
    }
    run.used.investigations++;
    await this.explainRun(run.traceId);
  }

  /** Explains a whole run: likely cause, the spans that show it, and a fix. */
  async explainRun(traceId: string, opts: { force?: boolean; priority?: "interactive" | "low" } = {}): Promise<Explanation | undefined> {
    if (!opts.force) {
      const existing = this.roots.store.explanationFor("run", traceId);
      if (existing) return existing;
    }
    const snap = loadTrace(this.roots.store, traceId);
    if (!snap.run) return undefined;
    const findings = this.roots.store.findingsForTrace(traceId).filter((f) => f.status !== "dismissed" && f.status !== "failed");
    const ev = buildEvidence(snap, { fields: ["input", "output", "status", "error"], final_output: true, last: 14 }, { budget: 7000 });
    const header = [
      `Run status: ${snap.run.status}${snap.run.termination_reason ? ` (${snap.run.termination_reason})` : ""}`,
      findings.length ? `Findings:\n${findings.map((f) => `- ${f.title}${f.probability !== null ? ` (p=${f.probability.toFixed(2)})` : ""}`).join("\n")}` : "Findings: none",
    ].join("\n");
    const r = await this.llm.chat(
      [
        { role: "system", content: INVESTIGATE_SYSTEM },
        { role: "user", content: `${header}\n\nExplain the most likely cause of any problem in this run. If the run looks fine, say so.\n\n${wrapRun(ev.text)}` },
      ],
      { schema: { name: "investigation", schema: INVESTIGATE_SCHEMA }, maxTokens: 450, priority: opts.priority ?? "low" },
    );
    const out = r.json as { cause?: string; evidence?: string[]; fix?: string } | undefined;
    if (!out?.cause) return undefined;
    const spanIds = resolveRefs(snap, out.evidence);
    const grounding = await this.grounding(ev.text, `${out.cause}\nFix: ${out.fix ?? ""}`);
    const exp = this.roots.store.insertExplanation({
      target_type: "run",
      target_id: traceId,
      trace_id: traceId,
      cause: out.cause,
      fix: out.fix ?? null,
      evidence_span_ids: spanIds.length ? spanIds : ev.spanIds.slice(-3),
      grounding,
      model: r.model,
    });
    this.roots.bus.emit("explanation", exp);
    return exp;
  }

  private async summarize(run: LiveRun, snap: TraceSnapshot): Promise<void> {
    if (run.used.summaries >= this.roots.config.budgets.summariesPerRun) return;
    if (this.roots.store.getSummary(run.traceId)) return;
    if (!(await this.llm.isAvailable())) return;
    run.used.summaries++;
    const findings = this.roots.store.findingsForTrace(run.traceId).filter((f) => f.status !== "dismissed" && f.status !== "failed");
    const ev = buildEvidence(snap, { fields: ["input", "output", "status", "error"], final_output: true, last: 12 }, { budget: 5000 });
    const header = `Status: ${snap.run?.status ?? "unknown"}. Findings: ${findings.length ? findings.map((f) => f.title).join("; ") : "none"}.`;
    try {
      const r = await this.llm.chat(
        [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: `${header}\n\n${wrapRun(ev.text)}` },
        ],
        { schema: { name: "summary", schema: SUMMARY_SCHEMA }, maxTokens: 220, priority: "low" },
      );
      const lines = (r.json as { lines?: string[] } | undefined)?.lines?.filter((l) => typeof l === "string" && l.trim());
      if (!lines?.length) return;
      const text = lines.slice(0, 3).map((l) => clip(l.trim().replace(/^\d+[.)]\s*/, ""), 200)).join("\n");
      this.roots.store.setSummary(run.traceId, text, r.model);
      this.roots.bus.emit("summary", { trace_id: run.traceId, text });
    } catch (err) {
      log.debug(`summary failed: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------ on-demand checks

  /** Answers a typed yes/no question over chosen spans of a trace (MCP judge, self-check). */
  async judge(traceId: string, ask: string, opts: { spanIds?: string[]; type?: "yes_no" } = {}): Promise<{ probability: number; evidence_span_ids: string[]; backend: string; model: string }> {
    const snap = loadTrace(this.roots.store, traceId);
    let text: string;
    let spanIds: string[];
    if (opts.spanIds?.length) {
      const spans = pickSpans(snap.spans, opts.spanIds, traceId);
      const g = runGoal(snap);
      text = [g.user ? `User request: ${clip(g.user, 600)}` : "", "Spans:", ...spans.map((s) => describeSpan(s, ["input", "output", "status", "error"]))].filter(Boolean).join("\n");
      spanIds = spans.map((s) => s.id);
    } else {
      const ev = buildEvidence(snap, { fields: ["input", "output", "status", "error"], last: 15, final_output: snap.run?.status !== "running" });
      text = ev.text;
      spanIds = ev.spanIds;
    }
    const r = await this.decisions.decide(text, [{ name: "q", type: "yes_no", ask }], { priority: "interactive" });
    return { probability: r.answers.q?.probability ?? 0, evidence_span_ids: spanIds, backend: r.backend, model: r.model };
  }

  /** Runs a question over recent runs without raising findings, to see how often it would fire. */
  async previewCheck(check: QuestionCheck | RuleCheck, opts: { limit?: number; workflow?: string; project?: string; timeBudgetMs?: number; signal?: AbortSignal } = {}): Promise<{
    checked: number;
    hits: { trace_id: string; probability: number | null; evidence_span_ids: string[]; root_name: string | null }[];
    total: number;
    truncated: boolean;
  }> {
    const limit = opts.limit ?? 50;
    // Only runs the check would watch: the engine skips runs outside its applies_to, so a preview
    // over them would report hits the check can never raise. Look further back to still fill `limit`.
    const runs = this.roots.store
      .listRuns({ workflow: opts.workflow, project: opts.project, limit: check.applies_to ? 500 : limit })
      .filter((r) => r.status !== "running")
      .filter((r) => this.appliesTo(check, { project: r.project ?? "unknown", workflow: r.workflow ?? r.project ?? "unknown" }))
      .slice(0, limit);
    const deadline = Date.now() + (opts.timeBudgetMs ?? 90_000);
    const hits: { trace_id: string; probability: number | null; evidence_span_ids: string[]; root_name: string | null }[] = [];
    let checked = 0;
    for (const r of runs) {
      if (Date.now() > deadline) break;
      const snap = loadTrace(this.roots.store, r.trace_id);
      checked++;
      if (isRule(check)) {
        const hit = evaluateRule(check, snap, true);
        if (hit) hits.push({ trace_id: r.trace_id, probability: null, evidence_span_ids: hit.evidenceSpanIds, root_name: r.root_name });
        continue;
      }
      const targets = check.scope === "span" ? selectSpans(snap.spans, check.evidence?.spans).slice(-5) : [undefined];
      for (const focus of targets) {
        const ev = buildEvidence(snap, check.evidence, { focus });
        if (!ev.spanIds.length && !check.evidence?.final_output) continue;
        try {
          if (opts.signal?.aborted) break;
          const res = await this.decisions.decide(ev.text, [toQuestion(check, check.params ?? {})], { priority: "interactive", signal: opts.signal });
          const v = flagged(check, res);
          if (v.flagged) {
            hits.push({ trace_id: r.trace_id, probability: v.probability, evidence_span_ids: ev.spanIds, root_name: r.root_name });
            break;
          }
        } catch (err) {
          if (err instanceof DecisionUnavailableError) throw err;
        }
      }
    }
    return { checked, hits, total: runs.length, truncated: checked < runs.length };
  }

  /** Re-runs the checks for a finished run, e.g. after checks changed. `resume` keeps stored answers. */
  async recheck(traceId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const row = this.roots.store.getRun(traceId);
    if (!row) return;
    this.live.delete(traceId);
    const run = this.liveRun(traceId)!;
    run.ended = row.status !== "running";
    run.rechecked = true;
    if (opts.resume) {
      const done = this.roots.store.decisionsForTrace(traceId);
      for (const d of done) if (d.span_id) run.spanDone.add(`${d.check_id}:${d.span_id}`);
      run.answered = {
        traceChecks: new Set(done.filter((d) => !d.span_id).map((d) => d.check_id)),
        toolSpans: new Set(done.filter((d) => d.check_id === "neatroots.tool-result" && d.span_id).map((d) => d.span_id!)),
      };
    }
    const snap = loadTrace(this.roots.store, traceId);
    await this.track(traceId, this.handleSpans(run, snap.spans.map((s) => s.id)));
    if (run.ended) await this.track(traceId, this.handleEnd(run));
  }
}

/** How many interrupted runs a restart finishes; older ones are marked interrupted for Re-run checks. */
const RESUME_LIMIT = 200;

export async function resumeUnfinished(engine: Engine, roots: Roots): Promise<number> {
  const ids = engine.progress.unfinished();
  const ended = ids.filter((id) => {
    const r = roots.store.getRun(id);
    if (!r) engine.progress.done(id);
    return !!r && r.status !== "running";
  });
  for (const id of ended.slice(RESUME_LIMIT)) engine.progress.interrupted(id);
  const todo = ended.slice(0, RESUME_LIMIT);
  if (todo.length) log.info(`finishing checks for ${todo.length} run${todo.length === 1 ? "" : "s"} a restart interrupted`);
  for (const id of todo) await engine.recheck(id, { resume: true });
  return todo.length;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "check";
}

/** A cheap first pass at labeling a tool result; undefined means "ask the classifier". */
export function heuristicToolLabel(s: SpanInfo): "success" | "empty" | "error" | "partial" | undefined {
  if (s.status === "error") return "error";
  const out = s.output;
  if (out === undefined || out === null) return "empty";
  if (typeof out === "string" && !out.trim()) return "empty";
  if (Array.isArray(out) && out.length === 0) return "empty";
  if (typeof out === "object" && !Array.isArray(out) && Object.keys(out).length === 0) return "empty";
  const text = (typeof out === "string" ? out : JSON.stringify(out)).slice(0, 400).toLowerCase();
  if (/\b(error|exception|not found|failed|denied|unauthori[sz]ed|forbidden|invalid|timed? ?out)\b|\b(4\d\d|5\d\d)\b/.test(text)) return undefined;
  return "success";
}

export { preview };
