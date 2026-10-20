import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import { checkToYaml } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { createApp } from "../src/server/app.js";
import { batch, hex, span } from "./helpers.js";

it.each(["rename", "edited-rename", "cross-directory", "edited-cross-directory", "shadow-copy", "legacy-rename", "legacy-shadow", "missing", "unregistered"])("MCP provenance survives real %s and restart without rewriting origin", async (mode) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-move-"));
  const config = defaultConfig();
  config.llm.enabled = false; config.classifier.laya.enabled = false;
  const userDir = path.join(home, "checks"), projectDir = path.join(home, "project");
  config.checkDirs = [projectDir];
  let roots = new Roots({ home, config });
  try {
    const check = { id: "moved-mcp", title: "Moved MCP", kind: "rule", action: "flag", rule: { type: "count", at_least: 1 } } as Check;
    const proposal = roots.checks.proposeMcp(check, null);
    const approved = roots.checks.approvePendingMcp(check.id, proposal.revision)!;
    const grant = roots.store.getMeta(`approved_mcp:${check.id}`);
    if (mode.startsWith("legacy")) roots.store.db.prepare("DELETE FROM meta WHERE key = ?").run(`mcp_origin:${check.id}`);
    const origin = roots.store.getMeta(`mcp_origin:${check.id}`);
    const targetDir = mode.includes("cross") || mode.includes("shadow") ? projectDir : mode === "unregistered" ? path.join(home, "outside") : userDir;
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "renamed.yaml");
    if (mode === "missing") fs.unlinkSync(approved.path!);
    else if (mode.includes("shadow")) fs.copyFileSync(approved.path!, target);
    else fs.renameSync(approved.path!, target);
    if (mode.startsWith("edited")) fs.writeFileSync(target, checkToYaml({ ...check, guidance: "unapproved edit" }));
    roots.checks.reload();
    roots.close(); roots = new Roots({ home, config });
    const absent = mode === "missing" || mode === "unregistered";
    if (absent) expect(roots.checks.get(check.id)).toBeUndefined();
    else {
      expect.soft(roots.checks.get(check.id)?.source).toBe("mcp");
      expect.soft(roots.checks.get(check.id)?.path).toBe(target);
    }
    expect.soft(roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(false);
    expect(roots.store.getMeta(`mcp_origin:${check.id}`)).toBe(origin);
    expect(roots.store.getMeta(`approved_mcp:${check.id}`)).toBe(grant);
    roots.store.ingest([batch([span({ traceId: hex(16), name: "stored-run", kind: "workflow" })])]);
    const response = await createApp(roots).request("/api/insights", { headers: { host: "localhost" } });
    expect(response.status).toBe(200);
    const data = await response.json() as { passing: { check_id: string }[] };
    expect.soft(data.passing.some((c) => c.check_id === check.id)).toBe(false);
    const trace = hex(16), root = span({ traceId: trace, name: "agent", kind: "workflow" });
    root.endTimeUnixNano = "0";
    roots.ingest([batch([root])]);
    expect(await roots.engine!.waitIdle(trace, 1000)).toBe(true);
    expect.soft(roots.store.listFindings({ traceId: trace }).some((f) => f.check_id === check.id)).toBe(false);
    if (!absent) {
      const pending = roots.checks.proposeMcp(check, null);
      expect.soft(pending.has_active_version).toBe(false);
      roots.checks.save(check, "user");
      roots.checks.reload();
      expect(roots.store.getMeta(`mcp_origin:${check.id}`)).toBeUndefined();
      expect(roots.store.getMeta(`approved_mcp:${check.id}`)).toBeUndefined();
      expect(roots.checks.get(check.id)?.source).not.toBe("mcp");
      expect(roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(true);
    }
  } finally { roots.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
it("malformed origin markers fail closed for nonlibrary IDs without tainting library checks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-invalid-origin-"));
  const config = defaultConfig(); config.classifier.laya.enabled = false;
  const roots = new Roots({ home, config, noEngine: true });
  try {
    const check = { id: "invalid-origin", kind: "rule", rule: { type: "count", at_least: 1 } } as Check;
    roots.checks.save(check, "user");
    const library = roots.checks.all().find((c) => c.source === "library")!;
    roots.store.setMeta(`mcp_origin:${check.id}`, "malformed provenance");
    roots.store.setMeta(`mcp_origin:${library.check.id}`, "malformed provenance");
    roots.checks.reload();
    expect(roots.checks.get(check.id)?.source).toBe("mcp");
    expect(roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(false);
    expect(roots.checks.get(library.check.id)?.source).toBe("library");
    roots.checks.save(check, "user");
    expect(roots.checks.get(check.id)?.source).toBe("user");
    expect(roots.store.getMeta(`mcp_origin:${check.id}`)).toBeUndefined();
  } finally { roots.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
