import type { Hono } from "hono";
import YAML from "yaml";
import type { Roots } from "../core.js";
import { AnyCheck, isQuestion, type Check } from "../checks/types.js";
import { parseChecks } from "../checks/registry.js";
import { checkWarnings } from "../checks/lint.js";
import { draftCheckFromConcern } from "../engine/assist.js";
import { err, body } from "./util.js";

/** Accepts a check as YAML text, a JSON object, or {yaml}. */
export function checkFromInput(input: unknown): { check?: Check; error?: string } {
  if (typeof input === "string" || (input && typeof (input as { yaml?: unknown }).yaml === "string")) {
    const text = typeof input === "string" ? input : (input as { yaml: string }).yaml;
    const { checks, errors } = parseChecks(text);
    if (errors.length) return { error: errors.map((e) => e.message).join("; ") };
    if (checks.length !== 1) return { error: "expected exactly one check" };
    return { check: checks[0] };
  }
  const obj = (input as { check?: unknown })?.check ?? input;
  const parsed = AnyCheck.safeParse(obj);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "check"}: ${i.message}`).join("; ") };
  return { check: parsed.data as Check };
}

/** Routes for checks: list, save, enable, draft from a concern, preview on past runs. */
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
        enabled: lc.check.enabled !== false && (roots.store.checkStats()[lc.check.id]?.enabled ?? 1) === 1,
        precision: roots.checks.precision(lc.check.id),
        yaml: YAML.stringify(lc.check),
        check: lc.check,
      })),
      errors: roots.checks.errors,
      library_dir: roots.checks.libraryDir,
      user_dir: `${roots.home}/checks`,
      project_dirs: roots.config.checkDirs,
    }),
  );

  app.post("/api/checks", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    const raw = ct.includes("yaml") || ct.includes("text/plain") ? await c.req.text() : await body(c);
    const { check, error } = checkFromInput(raw);
    if (!check) return err(c, 400, error ?? "invalid check");
    const dir = (raw as { dir?: string })?.dir;
    if (dir && !roots.config.checkDirs.includes(dir)) return err(c, 400, "dir must be a registered project checks directory");
    const saved = roots.checks.save(check, dir ? { dir } : "user");
    return c.json({ ok: true, id: saved.check.id, path: saved.path, source: saved.source, warnings: checkWarnings(check) });
  });

  app.post("/api/checks/:id/enabled", async (c) => {
    const b = await body<{ enabled?: boolean }>(c);
    if (!roots.checks.get(c.req.param("id"))) return err(c, 404, "check not found");
    if (typeof b.enabled !== "boolean") return err(c, 400, "enabled must be a boolean");
    roots.store.setCheckEnabled(c.req.param("id"), b.enabled);
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
      return err(c, 503, (e as Error).message);
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
      return err(c, 503, (e as Error).message);
    }
  });

  app.post("/api/checks/reload", (c) => {
    roots.checks.reload();
    return c.json({ ok: true, errors: roots.checks.errors });
  });

  app.get("/api/plans", (c) => c.json({ plans: roots.store.listPlans(50) }));
}
