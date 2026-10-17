import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Roots } from "../core.js";
import { kvToPlain } from "../otlp/types.js";
import { buildView } from "../semantics/view.js";
import { hardwareTier, LlmUnavailableError } from "../models/llm.js";
import { projectSettings, type SteeringMode } from "../config.js";
import { getCloudKey, setCloudKey, deleteCloudKey, getCloudToken, getSecret } from "../relay/keychain.js";
import { mountModelsApi } from "./api-models.js";
import { mountChecksApi } from "./api-checks.js";
import { mountInsightsApi } from "./api-insights.js";
import { mountAgentsApi } from "./api-agents.js";
import { importSource, mountExploreApi } from "./api-explore.js";
import { checkCoverage } from "./coverage.js";
import { installInfo } from "../util/install.js";
import { err, body, clampInt } from "./util.js";
import { checkDirState } from "../checks/registry.js";
import { askRuns } from "../engine/assist.js";
import { loadTrace } from "../engine/trace.js";
import { UnknownSpanError } from "../engine/engine.js";
import type { RunRow } from "../types.js";
import { VERSION } from "../version.js";

export { checkFromInput } from "./api-checks.js";

const STEERING_MODES: SteeringMode[] = ["off", "advisory", "gate", "self-check"];

export function runSummary(roots: Roots, r: RunRow) {
  const summary = roots.store.getSummary(r.trace_id);
  return {
    ...r,
    duration_ms: r.ended_ms && r.started_ms ? r.ended_ms - r.started_ms : null,
    summary: summary?.text ?? null,
    top_finding: r.open_finding_count > 0 ? roots.store.topOpenFinding(r.trace_id) : null,
    steering: roots.steering.mode(r.project),
  };
}

export function runDetail(roots: Roots, traceId: string) {
  const run = roots.store.getRun(traceId);
  if (!run) return undefined;
  const spans = roots.store.getSpans(traceId, false);
  const decisions = roots.store.decisionsForTrace(traceId);
  const toolLabels: Record<string, string> = {};
  for (const d of decisions) {
    if (d.check_id === "neatroots.tool-result" && d.span_id) toolLabels[d.span_id] = String((d.answer as { choice?: string })?.choice ?? "");
  }
  const findings = roots.store.findingsForTrace(traceId).map((f) => ({
    ...f,
    explanation: f.explanation_id ? roots.store.getExplanation(f.explanation_id) ?? null : null,
    precision: roots.checks.precision(f.check_id),
  }));
  const plan = run.plan_id ? roots.store.getPlan(run.plan_id) ?? null : null;
  return {
    run: runSummary(roots, run),
    spans: spans.map((s) => ({ ...s, tool_result: toolLabels[s.span_id] ?? null })),
    findings,
    notes: roots.store.notesForTrace(traceId),
    explanation: roots.store.explanationFor("run", traceId) ?? null,
    summary: roots.store.getSummary(traceId) ?? null,
    annotations: roots.store.annotationsForTrace(traceId),
    plan,
    decisions: decisions.filter((d) => d.check_id !== "neatroots.tool-result"),
    logs: roots.store.logsForTrace(traceId),
    forwarded: roots.store.forwardedTraceIds().has(traceId),
    replays: roots.replays.forRun(traceId),
    replay_of: roots.replays.originOf(traceId) ?? null,
    import_source: importSource(roots, traceId),
  };
}

export function spanDetail(roots: Roots, traceId: string, spanId: string) {
  const full = roots.store.getOtlpSpan(traceId, spanId);
  if (!full) return undefined;
  const view = buildView(full.span, full.resource.attributes);
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: full.span.parentSpanId || null,
    name: full.span.name,
    kind: view.kind,
    status: full.span.status,
    start_ns: full.span.startTimeUnixNano,
    end_ns: full.span.endTimeUnixNano,
    view,
    attributes: kvToPlain(full.span.attributes),
    events: full.span.events.map((e) => ({ name: e.name, time_ns: e.timeUnixNano, attributes: kvToPlain(e.attributes) })),
    links: full.span.links,
    resource: kvToPlain(full.resource.attributes),
    scope: { name: full.scope.name, version: full.scope.version ?? null },
  };
}

function projects(roots: Roots) {
  const rows = roots.store.db
    .prepare("SELECT project, COUNT(*) AS runs, MAX(started_ms) AS last_ms, SUM(finding_count > 0) AS with_findings FROM runs WHERE doctor = 0 GROUP BY project ORDER BY last_ms DESC")
    .all() as { project: string; runs: number; last_ms: number; with_findings: number }[];
  const names = new Set(rows.map((r) => r.project));
  for (const p of [...Object.keys(roots.config.projects), ...Object.keys(roots.config.rerun)]) names.add(p);
  return [...names].map((name) => {
    const r = rows.find((x) => x.project === name);
    return { project: name, runs: r?.runs ?? 0, last_ms: r?.last_ms ?? null, with_findings: r?.with_findings ?? 0, settings: projectSettings(roots.config, name), rerun: roots.config.rerun[name] ?? null };
  });
}

/** Cloud endpoints neatroots will forward to. Anything else must be set in config.yaml by hand. */
function allowedEndpoint(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:" && (url.hostname === "neatlogs.com" || url.hostname.endsWith(".neatlogs.com"))) return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** When an LLM task fails because no LLM is reachable, say so and how to fix it. */
function llmErrorMessage(e: unknown): string {
  if (e instanceof LlmUnavailableError) {
    return "No LLM is reachable. Set one up in Settings → Models, run `neatroots llm use <provider>`, or start a local LLM (Ollama/LM Studio).";
  }
  return (e as Error).message;
}

export function mountApi(app: Hono, roots: Roots): void {
  const engine = roots.engine;
  mountModelsApi(app, roots);
  mountChecksApi(app, roots);
  mountInsightsApi(app, roots);
  mountAgentsApi(app);
  mountExploreApi(app, roots);

  app.get("/api/status", async (c) => {
    const status = engine ? await engine.status() : null;
    const tier = hardwareTier();
    return c.json({
      name: "neatroots",
      version: VERSION,
      uptime_ms: Date.now() - roots.startedMs,
      port: roots.config.port,
      home: roots.home,
      install: installInfo(),
      stats: roots.store.stats(),
      engine: status,
      tier: { ...tier, platform: `${os.platform()} ${os.arch()}` },
      steering: { enabled: roots.config.steering.enabled, hooks_connected: roots.steering.listeners },
      mcp: { last_seen_ms: roots.mcpSeenMs },
      cloud: { endpoint: roots.relay.endpoint(), has_key: !!(await getCloudKey()), has_token: !!(await getCloudToken()), project_id: roots.config.cloud.projectId ?? null },
      classifier: {
        laya: { ...roots.laya.state, consent: roots.config.classifier.laya.consent ?? null },
        trust: Object.entries(roots.decisions.trust.all())
          .map(([question, t]) => ({ question, n: t.n, agreement: t.n ? t.agree / t.n : null, trusted: roots.decisions.trusted([{ name: question, type: "yes_no", ask: "" }]) }))
          .sort((a, b) => b.n - a.n),
        jev_cloud: { enabled: roots.config.classifier.jevCloud.enabled, has_key: !!(await getSecret("jev-api-key")) },
      },
      check_errors: roots.checks.errors,
      config: {
        llm: { baseUrl: roots.config.llm.baseUrl, model: roots.config.llm.model, enabled: roots.config.llm.enabled, external: roots.config.llm.external },
        classifier: { backend: roots.config.classifier.backend, baseUrl: roots.config.classifier.baseUrl, model: roots.config.classifier.model },
        budgets: roots.config.budgets,
        retention: roots.config.retention,
        grpc_port: roots.config.grpcPort,
      },
    });
  });

  // ------------------------------------------------------------------ runs

  app.get("/api/runs", (c) => {
    const q = c.req.query();
    const filter = {
      project: q.project || undefined,
      workflow: q.workflow || undefined,
      status: q.status || undefined,
      sessionId: q.session || undefined,
      hasFinding: q.has_finding === "1" || q.has_finding === "true",
      checkId: q.check || undefined,
      text: q.q || undefined,
      sinceMs: q.since ? Number(q.since) : undefined,
    };
    const runs = roots.store.listRuns({ ...filter, limit: clampInt(q.limit, 100, 1, 500), offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER) });
    // total: every run (the page says "no runs yet" when it's 0); matching: runs these filters match.
    return c.json({ runs: runs.map((r) => runSummary(roots, r)), total: roots.store.countRuns(), matching: roots.store.countMatchingRuns(filter) });
  });

  app.get("/api/runs/:traceId", async (c) => {
    const d = runDetail(roots, c.req.param("traceId"));
    return d ? c.json({ ...d, coverage: await checkCoverage(roots, c.req.param("traceId")) }) : err(c, 404, "run not found");
  });

  app.get("/api/runs/:traceId/spans/:spanId", (c) => {
    const d = spanDetail(roots, c.req.param("traceId"), c.req.param("spanId"));
    return d ? c.json(d) : err(c, 404, "span not found");
  });

  app.post("/api/runs/:traceId/pin", async (c) => {
    const b = await body<{ pinned?: boolean }>(c);
    roots.store.setPinned(c.req.param("traceId"), b.pinned !== false);
    return c.json({ ok: true });
  });

  app.delete("/api/runs/:traceId", (c) => {
    roots.store.deleteRun(c.req.param("traceId"));
    if (roots.focus?.trace_id === c.req.param("traceId")) roots.focus = null;
    return c.json({ ok: true });
  });

  app.post("/api/runs/:traceId/explain", async (c) => {
    if (!engine) return err(c, 503, "engine not running");
    try {
      const exp = await engine.explainRun(c.req.param("traceId"), { force: true, priority: "interactive" });
      return exp ? c.json(exp) : err(c, 422, "could not explain this run");
    } catch (e) {
      return err(c, 503, llmErrorMessage(e));
    }
  });

  app.post("/api/runs/:traceId/recheck", async (c) => {
    if (!engine) return err(c, 503, "engine not running");
    void engine.recheck(c.req.param("traceId"));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- findings

  app.get("/api/findings", (c) => {
    const q = c.req.query();
    return c.json({ findings: roots.store.listFindings({ traceId: q.trace_id, status: q.status, checkId: q.check_id, limit: clampInt(q.limit, 100, 1, 500) }) });
  });

  app.post("/api/findings/:id", async (c) => {
    const b = await body<{ status?: string }>(c);
    if (!b.status || !["dismissed", "active", "resolved", "raised"].includes(b.status)) return err(c, 400, "status must be dismissed, active, resolved or raised");
    const f = roots.store.updateFinding(c.req.param("id"), { status: b.status as "dismissed" });
    if (!f) return err(c, 404, "finding not found");
    if (b.status === "dismissed" || b.status === "resolved") roots.steering.withdraw(f.id);
    roots.bus.emit("finding", f);
    return c.json(f);
  });

  app.post("/api/findings/:id/investigate", async (c) => {
    if (!engine) return err(c, 503, "engine not running");
    const f = roots.store.getFinding(c.req.param("id"));
    if (!f) return err(c, 404, "finding not found");
    try {
      const exp = await engine.investigate(f.trace_id, f.id);
      return exp ? c.json(exp) : err(c, 422, "could not investigate this finding");
    } catch (e) {
      return err(c, 503, llmErrorMessage(e));
    }
  });

  app.post("/api/annotations", async (c) => {
    const b = await body<{ trace_id?: string; span_id?: string; label?: string; text?: string; author?: string }>(c);
    if (!b.trace_id || !b.label || !["issue", "good", "note"].includes(b.label)) return err(c, 400, "trace_id and label (issue, good or note) are required");
    const a = roots.store.insertAnnotation({ trace_id: b.trace_id, span_id: b.span_id ?? null, label: b.label as "issue", text: b.text ?? null, author: b.author ?? "user" });
    roots.bus.emit("activity", { trace_id: b.trace_id, kind: "annotation", message: a.label });
    return c.json(a);
  });

  // ------------------------------------------------------------ settings

  app.get("/api/projects", (c) => c.json({ projects: projects(roots) }));

  app.post("/api/settings", async (c) => {
    const b = await body<{
      project?: string;
      steering?: SteeringMode;
      forward?: boolean;
      steering_enabled?: boolean;
      llm_model?: string;
      llm_base_url?: string;
      classifier_backend?: "auto" | "laya" | "jev" | "jev-cloud" | "llm";
      jev_cloud_enabled?: boolean;
      laya_enabled?: boolean;
      classifier_url?: string;
      cloud_endpoint?: string;
      redact_patterns?: string[];
      check_dir?: string;
      retention_days?: number;
      retention_max_gb?: number;
    }>(c);
    // Check every value first, before anything changes: a refused request applies nothing, not
    // even its valid parts (an out-of-range retention used to be skipped while the reply said ok).
    const inRange = (v: unknown, min: number, max: number, minOpen = false) => typeof v === "number" && Number.isFinite(v) && (minOpen ? v > min : v >= min) && v <= max;
    if (b.retention_days !== undefined && !inRange(b.retention_days, 1, 3650)) return err(c, 400, "Keep runs for must be between 1 and 3650 days");
    if (b.retention_max_gb !== undefined && !inRange(b.retention_max_gb, 0, 10_000, true)) return err(c, 400, "Size cap must be more than 0 GB and at most 10000 GB");
    for (const field of ["forward", "steering_enabled", "jev_cloud_enabled", "laya_enabled"] as const) {
      if (b[field] !== undefined && typeof b[field] !== "boolean") return err(c, 400, `${field} must be a boolean`);
    }
    if (b.project && b.steering !== undefined && !STEERING_MODES.includes(b.steering)) return err(c, 400, `steering must be one of ${STEERING_MODES.join(", ")}`);
    if (b.classifier_backend && !["auto", "laya", "jev", "jev-cloud", "llm"].includes(b.classifier_backend)) return err(c, 400, "classifier_backend must be auto, laya, jev, jev-cloud or llm");
    if (b.cloud_endpoint && !allowedEndpoint(b.cloud_endpoint)) return err(c, 400, "cloud endpoint must be an https://*.neatlogs.com URL (or localhost for testing)");
    for (const p of b.redact_patterns ?? []) {
      try {
        new RegExp(p);
      } catch {
        return err(c, 400, `invalid pattern: ${p}`);
      }
    }
    // A check_dir is checked here with the rest, before anything is pushed or saved. Registering one
    // used to reload straight away, so a path that wasn't a directory threw out of this handler: the
    // reply was a 500, the bad path stayed on config.checkDirs, and the next settings save wrote it
    // into config.yaml, where the next start died inside the CheckRegistry constructor (#224).
    let checkDir: string | undefined;
    if (b.check_dir !== undefined) {
      if (typeof b.check_dir !== "string" || !b.check_dir.trim()) return err(c, 400, "check_dir must be a directory path");
      if (!path.isAbsolute(b.check_dir.trim())) return err(c, 400, "check_dir must be an absolute path");
      // Stored resolved, the way `neatroots init` stores one, so a trailing separator or a `..`
      // still points at the same directory on the next start. A directory that isn't there yet is
      // accepted: CheckRegistry.save() creates it, and `neatroots init` registers one the same way.
      checkDir = path.resolve(b.check_dir.trim());
      const state = checkDirState(checkDir);
      if (!state.ok && !state.creatable) return err(c, 400, `check_dir ${checkDir} ${state.reason}`);
    }
    if (b.project) {
      const cur = roots.config.projects[b.project] ?? {};
      if (b.steering !== undefined) roots.steering.setMode(b.project, b.steering);
      if (b.forward !== undefined) roots.config.projects[b.project] = { ...cur, ...roots.config.projects[b.project], forward: b.forward };
    }
    if (b.retention_days !== undefined) roots.config.retention.days = Math.round(b.retention_days);
    if (b.retention_max_gb !== undefined) roots.config.retention.maxGb = b.retention_max_gb;
    if (b.steering_enabled !== undefined) roots.config.steering.enabled = b.steering_enabled;
    if (b.llm_model) roots.config.llm.model = b.llm_model;
    if (b.llm_base_url) roots.config.llm.baseUrl = b.llm_base_url;
    if (b.classifier_backend) roots.config.classifier.backend = b.classifier_backend;
    if (b.classifier_url) roots.config.classifier.baseUrl = b.classifier_url;
    if (b.jev_cloud_enabled !== undefined) roots.config.classifier.jevCloud.enabled = b.jev_cloud_enabled;
    if (b.laya_enabled !== undefined) {
      roots.setLayaEnabled(b.laya_enabled);
      if (b.laya_enabled) roots.startModels();
      else roots.laya.stop();
    }
    roots.decisions.reset();
    if (b.cloud_endpoint) roots.config.cloud.endpoint = b.cloud_endpoint;
    if (b.redact_patterns) roots.config.cloud.redactPatterns = b.redact_patterns;
    if (checkDir && !roots.config.checkDirs.includes(checkDir)) {
      // Validated above, and reload() records anything it can't load instead of throwing.
      roots.config.checkDirs.push(checkDir);
      roots.checks.reload();
    }
    roots.saveConfig();
    if (b.llm_model || b.llm_base_url) await roots.llm.probe(true);
    roots.bus.emit("settings", { project: b.project });
    return c.json({ ok: true, projects: projects(roots) });
  });

  // --------------------------------------------------------------- cloud

  app.post("/api/cloud/key", async (c) => {
    const b = await body<{ key?: string }>(c);
    if (!b.key || b.key.length < 8) return err(c, 400, "paste the API key from app.neatlogs.com");
    const where = await setCloudKey(b.key.trim());
    return c.json({ ok: true, stored_in: where });
  });

  app.delete("/api/cloud/key", async (c) => {
    await deleteCloudKey();
    return c.json({ ok: true });
  });

  app.post("/api/cloud/preview", async (c) => {
    const b = await body<{ trace_ids?: string[] }>(c);
    if (!b.trace_ids?.length) return err(c, 400, "trace_ids required");
    return c.json(await roots.relay.preview(b.trace_ids));
  });

  app.post("/api/cloud/forward", async (c) => {
    const b = await body<{ trace_ids?: string[] }>(c);
    if (!b.trace_ids?.length) return err(c, 400, "trace_ids required");
    const row = await roots.relay.forward(b.trace_ids, "user");
    roots.bus.emit("activity", { kind: "forward", message: row.status });
    return c.json(row, row.status === "ok" ? 200 : 502);
  });

  app.get("/api/forwards", (c) => c.json({ forwards: roots.store.listForwards(100) }));

  // ------------------------------------------------------------- ask/search

  app.get("/api/search", (c) => c.json({ hits: roots.store.searchSpans(c.req.query("q") ?? "", 50) }));

  app.post("/api/ask", async (c) => {
    const b = await body<{ question?: string; trace_id?: string }>(c);
    if (!b.question) return err(c, 400, "question required");
    try {
      return c.json(await askRuns(roots, b.question, { traceId: b.trace_id }));
    } catch (e) {
      return err(c, 503, llmErrorMessage(e));
    }
  });

  // ------------------------------------------------------- live app events

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | undefined;
      const off = roots.bus.onAny(({ event, payload }) => {
        const p = payload as Record<string, unknown>;
        const data: Record<string, unknown> = { trace_id: p.trace_id ?? p.traceId ?? null };
        if (event === "trace") {
          const u = payload as { traceId: string; runCreated: boolean; rootEnded: boolean };
          data.created = u.runCreated;
          data.ended = u.rootEnded;
        }
        if (event === "finding" || event === "note") data.id = p.id;
        if (event === "settings") data.project = p.project ?? null;
        if (event === "navigate") data.path = p.path;
        if (event === "chat") Object.assign(data, { session_id: p.session_id, event: p.event, state: p.state });
        if (event === "import" || event === "replay") Object.assign(data, p);
        queue.push({ event, data: JSON.stringify(data) });
        wake?.();
      });
      stream.onAbort(() => off());
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ version: VERSION }) });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15000)]);
          wake = undefined;
        }
        if (!queue.length) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        for (const m of queue.splice(0, 200)) await stream.writeSSE(m);
      }
      off();
    }),
  );

  // -------------------------------------------------------------- steering

  app.get("/api/steer/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | undefined;
      const off = roots.steering.subscribe((e) => {
        queue.push({ event: e.event, data: JSON.stringify(e.data) });
        wake?.();
      });
      stream.onAbort(() => off());
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ version: VERSION, enabled: roots.config.steering.enabled }) });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15000)]);
          wake = undefined;
        }
        if (!queue.length) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        for (const m of queue.splice(0, 200)) await stream.writeSSE(m);
      }
      off();
    }),
  );

  app.get("/api/steer/mode", (c) => {
    const project = c.req.query("project");
    return c.json({ mode: roots.steering.mode(project), enabled: roots.config.steering.enabled });
  });

  app.post("/api/steer/claim", async (c) => {
    const b = await body<{ trace_id?: string; span_id?: string; gate_ms?: number; project?: string }>(c);
    if (typeof b.trace_id !== "string" || !b.trace_id) return err(c, 400, "trace_id required");
    const run = roots.store.getRun(b.trace_id);
    // Before any span of this run has arrived neatroots cannot know its project; say so, so the
    // hook flushes the SDK and asks again instead of caching "off".
    if (!run && !b.project) return c.json({ mode: "unknown", known: false, note: null });
    const mode = roots.steering.mode(run?.project ?? b.project);
    const wait = mode === "gate" ? (b.gate_ms ?? roots.config.steering.gateWaitMs) : 0;
    const note = wait > 0 ? await roots.steering.gate(b.trace_id, wait, b.span_id) : roots.steering.claim(b.trace_id, b.span_id);
    return c.json({ mode, note: note ? { id: note.id, kind: note.kind, text: note.text, finding_id: note.finding_id } : null });
  });

  app.post("/api/steer/check", async (c) => {
    if (!engine) return err(c, 503, "engine not running");
    const b = await body<{ trace_id?: string; question?: string; span_ids?: string[] }>(c);
    if (typeof b.trace_id !== "string" || !b.trace_id || !b.question) return err(c, 400, "trace_id and question required");
    if (!roots.store.getRun(b.trace_id)) return c.json({ probability: null, answer: "unknown", reason: "neatroots has not received spans for this run yet", evidence_span_ids: [] });
    try {
      const r = await engine.judge(b.trace_id, b.question, { spanIds: b.span_ids });
      roots.bus.emit("activity", { trace_id: b.trace_id, kind: "self-check", message: b.question });
      return c.json({ ...r, answer: r.probability >= 0.5 ? "yes" : "no" });
    } catch (e) {
      // A span id the run doesn't have: say so, like an unknown run, instead of blaming the model.
      if (e instanceof UnknownSpanError) return c.json({ probability: null, answer: "unknown", reason: e.message, evidence_span_ids: [] });
      return err(c, 503, llmErrorMessage(e));
    }
  });

  // ------------------------------------------------- focus and cloud pushes

  app.post("/api/focus", async (c) => {
    const b = await body<{ trace_id?: string; span_id?: string | null }>(c);
    if (b.trace_id !== undefined && typeof b.trace_id !== "string") return err(c, 400, "trace_id must be a string");
    // A run neatroots doesn't have can't be in focus.
    roots.focus = b.trace_id && roots.store.getRun(b.trace_id) ? { trace_id: b.trace_id, span_id: b.span_id ?? null, at: Date.now() } : null;
    return c.json({ ok: true });
  });

  app.get("/api/pushes", (c) => c.json({ pushes: [...roots.pushes.values()].sort((a, b) => b.created_ms - a.created_ms) }));

  app.post("/api/pushes/:id/:action", async (c) => {
    const p = roots.pushes.get(c.req.param("id"));
    if (!p) return err(c, 404, "push not found");
    if (p.status !== "pending") return c.json(p);
    if (c.req.param("action") === "decline") {
      p.status = "declined";
    } else if (c.req.param("action") === "confirm") {
      const row = await roots.relay.forward(p.trace_ids, "coding-agent (confirmed)");
      p.status = row.status === "ok" ? "sent" : "failed";
      p.forward_id = row.id;
      p.error = row.error ?? undefined;
    } else return err(c, 400, "action must be confirm or decline");
    roots.bus.emit("activity", { kind: "push", message: p.status });
    return c.json(p);
  });

  // Small helper for the UI: which spans changed since a sequence number.
  app.get("/api/runs/:traceId/snapshot", (c) => {
    const snap = loadTrace(roots.store, c.req.param("traceId"));
    return c.json({ spans: snap.spans.map((s) => ({ id: s.id, kind: s.kind, name: s.name, status: s.status })) });
  });
}
