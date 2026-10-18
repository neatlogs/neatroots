import fs from "node:fs";
import type { Hono } from "hono";
import type { Roots } from "../core.js";
import { loadTrace } from "../engine/trace.js";
import { runGoal } from "../engine/trace.js";
import { listCloudProjects, listCloudTraces, NO_CLOUD_TOKEN } from "../ingest/importers/neatlogs-cloud.js";
import { cloudImportAuth, cloudImportBase, ImportError, parseTraceFile } from "../ingest/importers/index.js";
import { deleteCloudToken, getCloudToken, setCloudToken } from "../relay/keychain.js";
import { buildChat } from "../semantics/chat-view.js";
import { body, clampInt, err, isTraceIds } from "./util.js";
import { runSummary } from "./api.js";
import { bodyLimit } from "hono/body-limit";
import type { RunFilter } from "../store/db.js";

// Run views (chat, conversation), search, imports, cloud import, replays and the in-app coding
// agent. Everything here is local; the cloud and import routes call out only when the user asks.

/** Where an imported run came from (neatroots.import.source on its resource), if it was imported. */
export function importSource(roots: Roots, traceId: string): string | null {
  const run = roots.store.getRun(traceId);
  if (!run?.root_span_id) return null;
  const full = roots.store.getOtlpSpan(traceId, run.root_span_id);
  const v = full?.resource.attributes.find((a) => a.key === "neatroots.import.source")?.value;
  return v && "stringValue" in v && v.stringValue !== "http" && v.stringValue !== "replay" ? v.stringValue : null;
}

/** The filters search understands. Any other word:value (a URL, host:port) is text to find. */
const FILTERS = new Set(["project", "status", "kind", "tool", "model", "check", "since", "session", "has"]);

/** `project:x status:failed kind:tool tool:lookup model:gpt has:problems check:id since:7d free text` */
export function parseSearch(q: string): { text: string; filters: Record<string, string> } {
  const filters: Record<string, string> = {};
  const words: string[] = [];
  for (const m of q.matchAll(/(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g)) {
    if (m[1] && FILTERS.has(m[1].toLowerCase())) filters[m[1].toLowerCase()] = m[3] ?? m[2];
    else words.push(m[1] ? m[0] : (m[4] ?? m[5]));
  }
  return { text: words.join(" ").trim(), filters };
}

/** The words people type for a run's status, mapped to what runs store. */
const STATUS: Record<string, string> = { failed: "error", failing: "error", error: "error", errored: "error", ok: "ok", succeeded: "ok", success: "ok", passed: "ok", running: "running", interrupted: "interrupted" };

function sinceMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([hdw])$/.exec(v);
  if (!m) return Date.parse(v) || undefined;
  return Date.now() - Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

export function mountExploreApi(app: Hono, roots: Roots): void {
  // ---------------------------------------------------------------- views

  app.get("/api/runs/:traceId/chat", (c) => {
    const traceId = c.req.param("traceId");
    if (!roots.store.getRun(traceId)) return err(c, 404, "run not found");
    return c.json(buildChat(loadTrace(roots.store, traceId), c.req.query("agent") || undefined));
  });

  app.get("/api/conversation", (c) => {
    const traceId = c.req.query("trace_id");
    const session = c.req.query("session") || (traceId ? roots.store.getRun(traceId)?.session_id : undefined);
    if (!session) return c.json({ session_id: null, runs: [] });
    const runs = roots.store.listRuns({ sessionId: session, limit: 500 }).sort((a, b) => (a.started_ms ?? 0) - (b.started_ms ?? 0));
    return c.json({ session_id: session, runs: runs.map((r) => runSummary(roots, r)) });
  });

  // ---------------------------------------------------------------- search

  app.get("/api/search/runs", (c) => {
    const { text, filters } = parseSearch(c.req.query("q") ?? "");
    const limit = clampInt(c.req.query("limit"), 50, 1, 100);
    const offset = clampInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const kind = filters.kind?.toUpperCase();
    // The store matches every filter and the text in SQL, so the total and the page cover all runs.
    const filter: RunFilter = {
      text: text || undefined,
      project: filters.project,
      status: filters.status && (STATUS[filters.status.toLowerCase()] ?? filters.status),
      sessionId: filters.session,
      checkId: filters.check,
      hasOpenFinding: filters.has === "problems",
      sinceMs: sinceMs(filters.since),
      spanKind: kind,
      tool: filters.tool,
      model: filters.model,
    };
    const runs = roots.store.listRuns({ ...filter, limit, offset });
    // Snippets only for the runs on this page, at most five each.
    // One run with over 1000 matching spans can crowd out the rest of the page's snippets.
    const hits = text && runs.length ? roots.store.searchSpans(text, 1000, runs.map((r) => r.trace_id)) : [];
    const byRun = new Map<string, { span_id: string; name: string; snippet: string; kind?: string }[]>();
    const kinds = new Map<string, string>();
    if (hits.length && (kind || filters.tool || filters.model)) {
      const rows = roots.store.db
        .prepare(`SELECT trace_id, span_id, span_kind AS kind, tool_name, model FROM spans WHERE (trace_id, span_id) IN (${hits.map(() => "(?, ?)").join(",")})`)
        .all(...hits.flatMap((h) => [h.trace_id, h.span_id])) as { trace_id: string; span_id: string; kind: string; tool_name: string | null; model: string | null }[];
      for (const r of rows) {
        const ok = (!kind || r.kind === kind) && (!filters.tool || (r.tool_name ?? "").toLowerCase().includes(filters.tool.toLowerCase())) && (!filters.model || (r.model ?? "").toLowerCase().includes(filters.model.toLowerCase()));
        if (ok) kinds.set(`${r.trace_id}:${r.span_id}`, r.kind);
      }
    }
    for (const h of hits) {
      if ((kind || filters.tool || filters.model) && !kinds.has(`${h.trace_id}:${h.span_id}`)) continue;
      const list = byRun.get(h.trace_id) ?? [];
      if (list.length < 5) list.push({ span_id: h.span_id, name: h.name, snippet: h.snippet, kind: kinds.get(`${h.trace_id}:${h.span_id}`) });
      byRun.set(h.trace_id, list);
    }
    return c.json({ query: { text, filters }, total: roots.store.countMatchingRuns(filter), runs: runs.map((r) => ({ ...runSummary(roots, r), hits: byRun.get(r.trace_id) ?? [] })) });
  });

  // --------------------------------------------------------------- imports

  app.get("/api/imports", (c) => c.json({ jobs: roots.imports.list() }));
  app.post("/api/imports", async (c) => {
    const b = await body<{ source: string; values?: Record<string, string>; since_ms?: number; until_ms?: number; limit?: number; project?: string }>(c);
    try {
      const { job } = roots.imports.start(b.source, b.values ?? {}, { sinceMs: b.since_ms, untilMs: b.until_ms, limit: b.limit, project: b.project || undefined });
      return c.json(job, 202);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });
  app.post("/api/imports/:id/cancel", (c) => (roots.imports.cancel(c.req.param("id")) ? c.json({ ok: true }) : err(c, 404, "no running import with that id")));
  // Same cap as the collector: a bigger body is refused before it is read into memory.
  const importLimit = bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => err(c, 413, "the file is larger than 64 MB; split it, or send it to /v1/traces in parts") });
  app.post("/api/imports/file", importLimit, async (c) => {
    const b = await body<{ name?: string; content?: string; project?: string }>(c);
    if (!b.content) return err(c, 400, "content is required");
    try {
      const batches = parseTraceFile(b.content, b.name ?? "upload.json", b.project || undefined);
      const updates = roots.ingest(batches);
      return c.json({ traces: updates.length, spans: batches.reduce((n, x) => n + x.spans.length, 0), trace_ids: updates.map((u) => u.traceId).slice(0, 50) });
    } catch (e) {
      return err(c, e instanceof ImportError ? 400 : 500, (e as Error).message);
    }
  });

  // Importing reads Neatlogs Cloud with a service-account token (Keychain) and a chosen project.
  app.post("/api/cloud/import-auth", async (c) => {
    const b = await body<{ token?: string; project_id?: string | null }>(c);
    const token = b.token?.trim();
    if (token) await setCloudToken(token);
    if (b.project_id !== undefined) {
      roots.config.cloud.projectId = b.project_id?.trim() || undefined;
      roots.saveConfig();
    }
    return c.json({ has_token: !!(await getCloudToken()), project_id: roots.config.cloud.projectId ?? null });
  });
  app.delete("/api/cloud/import-auth", async (c) => {
    await deleteCloudToken();
    roots.config.cloud.projectId = undefined;
    roots.saveConfig();
    return c.json({ has_token: false, project_id: null });
  });
  app.get("/api/cloud/projects", async (c) => {
    const token = await getCloudToken();
    if (!token) return err(c, 400, NO_CLOUD_TOKEN);
    try {
      return c.json({ projects: await listCloudProjects(cloudImportBase(roots), token), project_id: roots.config.cloud.projectId ?? null });
    } catch (e) {
      return err(c, 502, (e as Error).message);
    }
  });

  app.get("/api/cloud/traces", async (c) => {
    const auth = await cloudImportAuth(roots);
    if (!auth) return err(c, 400, NO_CLOUD_TOKEN);
    try {
      const page = await listCloudTraces(cloudImportBase(roots), auth, { cursor: c.req.query("cursor") || undefined, limit: 50 });
      const local = new Set(page.traces.filter((t) => roots.store.getRun(t.traceId)).map((t) => t.traceId));
      return c.json({ traces: page.traces.map((t) => ({ ...t, local: local.has(t.traceId) })), next_cursor: page.nextCursor });
    } catch (e) {
      return err(c, 502, (e as Error).message);
    }
  });
  app.post("/api/cloud/import", async (c) => {
    const b = await body<{ trace_ids?: unknown }>(c);
    if (!isTraceIds(b.trace_ids)) return err(c, 400, "trace_ids must be a non-empty array of run ids");
    try {
      const { job } = roots.imports.start("neatlogs-cloud", { traceIds: b.trace_ids.join(",") }, { limit: b.trace_ids.length });
      return c.json(job, 202);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  // --------------------------------------------------------------- replays

  app.get("/api/runs/:traceId/replay-options", async (c) => {
    const traceId = c.req.param("traceId");
    const t = loadTrace(roots.store, traceId);
    if (!t.run) return err(c, 404, "run not found");
    const llm = await roots.llm.status();
    const target = roots.replays.target(t.run.project);
    return c.json({
      llm: { available: !!llm.active, where: llm.active, model: llm.active === "local" ? llm.local.model : (llm.external?.model ?? null) },
      run: target?.command || target?.url ? { via: target.url ? "http" : "command", command: target.command ?? null, url: target.url ?? null, cwd: target.cwd ?? null } : null,
      project: t.run.project,
      default_input: runGoal(t).user ?? runGoal(t).rootInput ?? "",
      system: runGoal(t).system ?? null,
      replays: roots.replays.forRun(traceId),
    });
  });
  app.post("/api/runs/:traceId/replay", async (c) => {
    const traceId = c.req.param("traceId");
    const b = await body<{ span_id?: string; messages?: { role: string; content: string }[]; edit?: { from: string; to: string }; input?: string; model?: string; system?: string }>(c);
    try {
      if (b.span_id) return c.json(await roots.replays.replayLlm(traceId, b.span_id, { messages: b.messages, edit: b.edit, model: b.model || undefined, system: b.system || undefined }));
      const { replay } = roots.replays.startRun(traceId, { input: b.input, model: b.model || undefined, system: b.system || undefined });
      return c.json(replay, 202);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });
  app.get("/api/replays/:id", (c) => {
    const r = roots.replays.get(c.req.param("id"));
    return r ? c.json(r) : err(c, 404, "no such replay");
  });
  app.post("/api/projects/:project/rerun", async (c) => {
    const project = c.req.param("project");
    const b = await body<{ command?: string; cwd?: string; url?: string }>(c);
    const command = b.command?.trim() || undefined;
    const url = b.url?.trim() || undefined;
    if (url && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)) return err(c, 400, "the replay endpoint must be on this machine (http://localhost:…/)");
    const cwd = b.cwd?.trim() || undefined;
    if (command && cwd && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) return err(c, 400, `no such folder: ${cwd}`);
    if (!command && !url) delete roots.config.rerun[project];
    else roots.config.rerun[project] = { command, cwd, url };
    roots.saveConfig();
    return c.json({ project, rerun: roots.config.rerun[project] ?? null });
  });

  // -------------------------------------------------------- coding agents

  app.get("/api/chat/agents", (c) => c.json({ agents: roots.chats.agents(), elsewhere: roots.chats.elsewhere() }));
  app.get("/api/chat/sessions", (c) => c.json({ sessions: roots.chats.list() }));
  app.post("/api/chat/sessions", async (c) => {
    const b = await body<{ agent: "claude" | "codex"; cwd?: string; trace_id?: string; allow_edits?: boolean; allow_commands?: boolean; title?: string }>(c);
    if (b.agent !== "claude" && b.agent !== "codex") return err(c, 400, "agent must be claude or codex");
    try {
      return c.json(roots.chats.create(b), 201);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });
  app.get("/api/chat/sessions/:id", (c) => {
    const s = roots.chats.get(c.req.param("id"));
    return s ? c.json({ session: s, events: roots.chats.events(s.id, clampInt(c.req.query("after"), 0, 0, Number.MAX_SAFE_INTEGER)) }) : err(c, 404, "no such chat");
  });
  app.patch("/api/chat/sessions/:id", async (c) => {
    const b = await body<{ allow_edits?: boolean; allow_commands?: boolean; title?: string }>(c);
    try {
      return c.json(roots.chats.update(c.req.param("id"), b));
    } catch (e) {
      return err(c, 404, (e as Error).message);
    }
  });
  app.delete("/api/chat/sessions/:id", (c) => {
    roots.chats.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/chat/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const b = await body<{ text: string }>(c);
    if (typeof b.text !== "string" || !b.text.trim()) return err(c, 400, "text is required");
    const s = roots.chats.get(id);
    if (!s) return err(c, 404, "no such chat");
    if (s.state === "running") return err(c, 409, "the agent is still answering");
    void roots.chats.send(id, b.text.trim()).catch((e) => roots.bus.emit("chat", { session_id: id, event: { kind: "error", text: (e as Error).message } }));
    return c.json({ ok: true }, 202);
  });
  app.post("/api/chat/sessions/:id/stop", (c) => c.json({ stopped: roots.chats.stop(c.req.param("id")) }));
}
