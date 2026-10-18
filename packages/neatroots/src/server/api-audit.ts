import type { Hono } from "hono";
import type { Roots } from "../core.js";
import path from "node:path";
import { AuditArchive, type ExportOptions } from "../audit/archive.js";
import { verifyArchive } from "../audit/manifest.js";
import { body, err } from "./util.js";

/** Mounted behind the same loopback Host/Origin checks as the other local APIs. */
export function mountAuditApi(app: Hono, roots: Roots): void {
  const archive = new AuditArchive(roots);
  app.post("/api/audit/export", async (c) => {
    const b = await body<ExportOptions & { trace_id?: string }>(c);
    if (!b || typeof b.trace_id !== "string") return err(c, 400, "trace_id is required");
    for (const key of ["directory", "output", "preview_token"] as const) {
      if (b[key] !== undefined && typeof b[key] !== "string") return err(c, 400, `${key} must be a string`);
    }
    for (const key of ["redacted", "preview"] as const) {
      if (b[key] !== undefined && typeof b[key] !== "boolean") return err(c, 400, `${key} must be boolean`);
    }
    try { return c.json(archive.export(b.trace_id, b)); }
    catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.post("/api/audit/verify", async (c) => {
    const b = await body<{ directory?: string; expect_head?: string }>(c);
    if (!b || (b.directory !== undefined && typeof b.directory !== "string")
      || (b.expect_head !== undefined && typeof b.expect_head !== "string")) return err(c, 400, "invalid verification options");
    const { entries: _, ...report } = verifyArchive(b.directory ?? path.join(roots.home, "audit"), b.expect_head);
    return c.json(report);
  });
}
