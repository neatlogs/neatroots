import type { Hono } from "hono";
import YAML from "yaml";
import type { Roots } from "../core.js";
import { AnyCheck, isQuestion, isRule, type Check } from "../checks/types.js";
import { parseChecks, checkDirState } from "../checks/registry.js";
import { checkWarnings } from "../checks/lint.js";
import { draftCheckFromConcern } from "../engine/assist.js";
import { err, body } from "./util.js";
import { llmErrorMessage } from "../models/llm.js";
import { regexProblem } from "../util/regex.js";

/** Accepts a check as YAML text, a JSON object, or {yaml}. */
export function checkFromInput(input: unknown): { check?: Check; error?: string } {
  if (typeof input === "string" || (input && typeof (input as { yaml?: unknown }).yaml === "string")) {
    const text = typeof input === "string" ? input : (input as { yaml: string }).yaml;
    const { checks, errors } = parseChecks(text);
    if (errors.length) return { error: errors.map((e) => e.message).join("; ") };
    if (checks.length !== 1) return { error: "expected exactly one check" };
    return newCheck(checks[0]);
  }
  const obj = (input as { check?: unknown })?.check ?? input;
  const parsed = AnyCheck.safeParse(obj);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "check"}: ${i.message}`).join("; ") };
  return newCheck(parsed.data as Check);
}

/**
 * A check being saved or previewed gets the full regex check: a pattern that nests repeats, like
 * (a+)+, is refused here, though one already saved in a file still loads.
 */
function newCheck(check: Check): { check?: Check; error?: string } {
  if (isRule(check) && check.rule.type === "match") {
    const problem = regexProblem(check.rule.pattern, check.rule.flags ?? "i");
    if (problem) return { error: `rule.pattern: ${problem}` };
  }
  return { check };
}

/** Routes for checks: list, immediate human save, MCP proposal approval/rejection, enable, draft, and preview. */
export function mountChecksApi(app: Hono, roots: Roots): void {
  const engine = roots.engine;

  // ---------------------------------------------------------------- checks

  app.get("/api/checks", (c) =>
    c.json({
      checks: roots.checks.all().map((lc) => ({
        id: lc.check.id,
        kind: lc.check.kind,
        title: lc.check.title ?? (isQuestion(lc.check) ? lc.check.ask : lc.check.id),
        source: lc.source,
        path: lc.path,
        enabled: (lc.source !== "mcp" || roots.checks.isApprovedMcp(lc.check.id)) && lc.check.enabled !== false && (roots.store.checkStats()[lc.check.id]?.enabled ?? 1) === 1,
        precision: roots.checks.precision(lc.check.id),
        yaml: YAML.stringify(lc.check),
        check: lc.check,
      })),
      errors: roots.checks.errors,
      library_dir: roots.checks.libraryDir,
      user_dir: `${roots.home}/checks`,
      project_dirs: roots.config.checkDirs,
      pending_mcp_checks: roots.checks.pendingMcp().map((proposal) => ({
        id: proposal.check.id,
        kind: proposal.check.kind,
        title: proposal.check.title ?? (isQuestion(proposal.check) ? proposal.check.ask : proposal.check.id),
        yaml: YAML.stringify(proposal.check),
        check: proposal.check,
        revision: proposal.revision,
        created_ms: proposal.created_ms,
        target_dir: proposal.target_dir,
        has_active_version: proposal.has_active_version,
      })),
    }),
  );

  app.post("/api/checks", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    const raw = ct.includes("yaml") || ct.includes("text/plain") ? await c.req.text() : await body(c);
    const { check, error } = checkFromInput(raw);
    if (!check) return err(c, 400, error ?? "invalid check");
    const dir = (raw as { dir?: string })?.dir;
    if (dir && !roots.config.checkDirs.includes(dir)) return err(c, 400, "dir must be a registered project checks directory");
    // A registered path can still be unusable, in a config written before #224 was fixed. Saving
    // into it would throw EEXIST out of this route, so say what is wrong with it instead. A
    // directory that isn't there yet is fine: save() makes it, the way a fresh clone works.
    if (dir) {
      const state = checkDirState(dir);
      if (!state.ok && !state.creatable) return err(c, 400, `that checks directory ${state.reason}`);
    }
    const saved = roots.checks.save(check, dir ? { dir } : "user");
    const warnings = checkWarnings(check);
    if (roots.steering.inactiveHalts([saved.check]).length) {
      warnings.push("This halt rule won't stop the agent until steering is on for the project (off sends nothing, halts included). Turn it on in the sidebar or with neatroots steering advisory --project <name>.");
    }
    return c.json({ ok: true, id: saved.check.id, path: saved.path, source: saved.source, warnings });
  });

  app.post("/api/checks/:id/approve", async (c) => {
    const b = await body<{ revision?: string }>(c);
    if (typeof b.revision !== "string" || !b.revision) return err(c, 400, "proposal revision is required");
    try {
      const approved = roots.checks.approvePendingMcp(c.req.param("id"), b.revision);
      if (!approved) return err(c, 404, "pending MCP check proposal not found");
      return c.json({ ok: true, id: approved.check.id, path: approved.path, source: approved.source });
    } catch (error) {
      if ((error as Error).message.includes("changed;") || (error as Error).message.includes("approval target conflict;") || (error as Error).message.includes("halt rules must be created")) return err(c, 409, (error as Error).message);
      throw error;
    }
  });

  app.post("/api/checks/:id/reject", async (c) => {
    const b = await body<{ revision?: string }>(c);
    if (typeof b.revision !== "string" || !b.revision) return err(c, 400, "proposal revision is required");
    try {
      if (!roots.checks.rejectPendingMcp(c.req.param("id"), b.revision)) return err(c, 404, "pending MCP check proposal not found");
      return c.json({ ok: true, id: c.req.param("id") });
    } catch (error) {
      if ((error as Error).message.includes("changed;")) return err(c, 409, (error as Error).message);
      throw error;
    }
  });

  app.post("/api/checks/:id/enabled", async (c) => {
    const b = await body<{ enabled?: boolean }>(c);
    if (!roots.checks.get(c.req.param("id"))) return err(c, 404, "check not found");
    roots.store.setCheckEnabled(c.req.param("id"), b.enabled !== false);
    return c.json({ ok: true });
  });

  app.delete("/api/checks/:id", (c) => (roots.checks.remove(c.req.param("id")) ? c.json({ ok: true }) : err(c, 400, "only user, project or planner checks can be deleted; disable library checks instead")));

  app.post("/api/checks/draft", async (c) => {
    const b = await body<{ concern?: string; workflow?: string; project?: string }>(c);
    if (!b.concern || b.concern.length < 8) return err(c, 400, "describe the concern in a sentence");
    try {
      const check = await draftCheckFromConcern(roots, b.concern, { workflow: b.workflow, project: b.project, signal: c.req.raw.signal });
      return c.json({ check, yaml: YAML.stringify(check), warnings: checkWarnings(check) });
    } catch (e) {
      return err(c, 503, llmErrorMessage(e));
    }
  });

  app.post("/api/checks/preview", async (c) => {
    if (!engine) return err(c, 503, "engine not running");
    const b = await body<{ check?: unknown; yaml?: string; limit?: number; workflow?: string; project?: string }>(c);
    const { check, error } = checkFromInput(b.yaml ? { yaml: b.yaml } : b.check);
    if (!check) return err(c, 400, error ?? "invalid check");
    try {
      const r = await engine.previewCheck(check, { limit: b.limit ?? 50, workflow: b.workflow, project: b.project, signal: c.req.raw.signal });
      return c.json({ ...r, hit_rate: r.checked ? r.hits.length / r.checked : null, warnings: checkWarnings(check) });
    } catch (e) {
      return err(c, 503, llmErrorMessage(e));
    }
  });

  app.post("/api/checks/reload", (c) => {
    roots.checks.reload();
    return c.json({ ok: true, errors: roots.checks.errors });
  });

  app.get("/api/plans", (c) => c.json({ plans: roots.store.listPlans(50) }));
}
