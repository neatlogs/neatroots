import type { Hono } from "hono";
import type { Roots } from "../core.js";
import { AuditArchive, type ExportOptions } from "../audit/archive.js";
import { archiveObservations } from "../audit/observations.js";
import { verifyArchive } from "../audit/manifest.js";
import { AuditCoverage } from "../audit/coverage.js";
import { body, err } from "./util.js";

/** Mounted behind the same loopback Host/Origin checks as the other local APIs. */
export function mountAuditApi(app: Hono, roots: Roots): void {
  const archive = new AuditArchive(roots);
  const coverage = new AuditCoverage(roots);
  app.get("/api/audit/status", (c) => c.json({ ...roots.audit.status(), coverage: coverage.status() }));
  app.post("/api/audit/export", async (c) => {
    const b = await body<ExportOptions & { trace_id?: string }>(c);
    if (!b || typeof b.trace_id !== "string") return err(c, 400, "trace_id is required");
    for (const key of ["directory", "output", "preview_token"] as const) {
      if (b[key] !== undefined && typeof b[key] !== "string") return err(c, 400, `${key} must be a string`);
    }
    for (const key of ["redacted", "preview"] as const) {
      if (b[key] !== undefined && typeof b[key] !== "boolean") return err(c, 400, `${key} must be boolean`);
    }
    try { return c.json(archive.export(b.trace_id, { ...b, directory: b.directory ?? roots.audit.directory() })); }
    catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.post("/api/audit/verify", async (c) => {
    const b = await body<{ directory?: string; expect_head?: string }>(c);
    if (!b || (b.directory !== undefined && typeof b.directory !== "string")
      || (b.expect_head !== undefined && typeof b.expect_head !== "string")) return err(c, 400, "invalid verification options");
    const directory = b.directory ?? roots.audit.directory();
    const verified = verifyArchive(directory, b.expect_head);
    archiveObservations(roots.store).verified(directory, verified);
    const { entries: _, ...report } = verified;
    return c.json(report);
  });
}
