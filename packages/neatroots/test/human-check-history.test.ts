import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import type { Check } from "../src/checks/types.js";
import { createApp } from "../src/server/app.js";

for (const origin of ["mcp", "project-mcp", "planner"] as const) for (const disabled of [true, false, "yaml"] as const) for (const failure of [true, false]) {
  it(`human API save preserves ${origin} history with disabled=${disabled}, failure=${failure}, across restart`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-takeover-"));
    const config = defaultConfig(); config.classifier.laya.enabled = false;
    const projectDir = path.join(home, "project-checks"); config.checkDirs = [projectDir];
    let roots = new Roots({ home, config, noEngine: true });
    try {
      const check = { id: "owned-check", kind: "rule", action: "flag", rule: { type: "count", at_least: 2 }, ...(disabled === "yaml" ? { enabled: false } : {}) } as Check;
      if (origin !== "planner") {
        const p = roots.checks.proposeMcp(check, origin === "project-mcp" ? projectDir : null);
        roots.checks.approvePendingMcp(check.id, p.revision);
      } else roots.checks.save(check, "db", "planner");
      roots.store.db.prepare("UPDATE checks SET hits=7, dismissed=3, confirmed=2, enabled=? WHERE id=?").run(disabled === true ? 0 : 1, check.id);
      const before = roots.store.checkStats()[check.id];
      const created = roots.store.db.prepare("SELECT created_ms FROM checks WHERE id=?").get(check.id);
      const grant = roots.store.getMeta(`approved_mcp:${check.id}`), marker = roots.store.getMeta(`mcp_origin:${check.id}`);
      const spy = failure ? vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("save failed"); }) : undefined;
      let response: Response;
      try { response = await createApp(roots).request("/api/checks", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ check: { ...check, title: "Human edit" } }) }); }
      finally { spy?.mockRestore(); }
      expect(response!.status).toBe(failure ? 500 : 200);
      roots.close(); roots = new Roots({ home, config, noEngine: true });
      expect.soft(roots.store.checkStats()[check.id]).toEqual(before);
      expect.soft(roots.store.db.prepare("SELECT created_ms FROM checks WHERE id=?").get(check.id)).toEqual(created);
      expect.soft(roots.checks.enabled().some((c) => c.check.id === check.id)).toBe(disabled === false);
      expect(roots.checks.get(check.id)?.source).toBe(failure ? origin === "planner" ? "planner" : "mcp" : origin === "project-mcp" ? "project" : "user");
      expect(roots.store.getMeta(`approved_mcp:${check.id}`)).toBe(failure ? grant : undefined);
      expect(roots.store.getMeta(`mcp_origin:${check.id}`)).toBe(failure ? marker : undefined);
      const listed = await (await createApp(roots).request("/api/checks", { headers: { host: "localhost" } })).json() as { checks: { id: string; enabled: boolean }[] };
      expect.soft(listed.checks.find((c) => c.id === check.id)?.enabled).toBe(disabled === false);
      if (origin === "project-mcp") expect(roots.checks.get(check.id)?.path).toBe(path.join(projectDir, `${check.id}.yaml`));
    } finally { vi.restoreAllMocks(); roots.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });
}