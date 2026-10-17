import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { Roots } from "../src/core.js";
import { CheckRegistry, checkToYaml } from "../src/checks/registry.js";
import type { Check } from "../src/checks/types.js";
import { Store } from "../src/store/db.js";
import { mountInsightsApi } from "../src/server/api-insights.js";
import { batch, hex, span } from "./helpers.js";

it.each(["recovered", "partial", "human-yaml-disabled", "edited", "moved", "approved", "yaml-disabled", "stats-disabled", "human", "human-disabled"])("insights, digest and pending active label agree for %s after reopen", async (mode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-reporting-"));
  const dataDir = path.join(dir, "data"), checksDir = path.join(dir, "checks");
  let store = new Store(dataDir);
  try {
    let registry = new CheckRegistry(store, checksDir, () => []);
    const check = { id: "reported-check", title: "Reported check", kind: "rule", action: "flag", rule: { type: "count", at_least: 99 }, guidance: "tail guidance" } as Check;
    if (mode.startsWith("human")) registry.save(check, "user");
    else {
      const p = registry.proposeMcp(check, null);
      if (mode === "partial") {
        const original = fs.writeFileSync;
        const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => { const { guidance: _guidance, ...partialCheck } = check; const partialYaml = checkToYaml(partialCheck); expect(partialYaml.length).toBeLessThan(String(data).length); original(file, partialYaml, options); throw new Error("partial approval"); });
        try { expect(() => registry.approvePendingMcp(check.id, p.revision)).toThrow("partial approval"); }
        finally { spy.mockRestore(); }
      } else if (mode === "recovered") {
        const original = store.upsertCheckRow.bind(store);
        const spy = vi.spyOn(store, "upsertCheckRow").mockImplementation((row) => { if (row.id === check.id) throw new Error("interrupted approval"); return original(row); });
        try { expect(() => registry.approvePendingMcp(check.id, p.revision)).toThrow("interrupted approval"); }
        finally { spy.mockRestore(); }
      } else registry.approvePendingMcp(check.id, p.revision);
    }
    const file = path.join(checksDir, `${check.id}.yaml`);
    if (mode === "edited") fs.writeFileSync(file, checkToYaml({ ...check, rule: { type: "count", at_least: 98 } } as Check));
    if (mode === "moved") {
      const origin = JSON.parse(store.getMeta(`mcp_origin:${check.id}`)!);
      const moved = path.join(checksDir, "moved.yaml");
      fs.renameSync(file, moved);
      store.setMeta(`mcp_origin:${check.id}`, JSON.stringify([origin[0], moved]));
    }
    if (mode === "yaml-disabled" || mode === "human-yaml-disabled") fs.writeFileSync(file, checkToYaml({ ...check, enabled: false }));
    if (mode === "stats-disabled" || mode === "human-disabled") store.setCheckEnabled(check.id, false);
    for (const loaded of registry.all()) if (loaded.source === "library") store.setCheckEnabled(loaded.check.id, false);
    store.ingest([batch([span({ traceId: hex(16), name: "report-run", kind: "workflow" })])]);
    store.close(); store = new Store(dataDir);
    registry = new CheckRegistry(store, checksDir, () => []);
    const proposal = (mode === "recovered" || mode === "partial") ? registry.pendingMcpCheck(check.id)! : registry.proposeMcp({ ...check, title: "Next version" }, null);
    expect(registry.get(check.id)).toBeDefined();
    const active = mode === "approved" || mode === "human";
    expect(registry.enabled().some((c) => c.check.id === check.id)).toBe(active);
    expect.soft(proposal.has_active_version).toBe(active);
    const grant = store.getMeta(`approved_mcp:${check.id}`);
    let digestPrompt = "";
    const app = new Hono();
    mountInsightsApi(app, { store, checks: registry, llm: { chat: async (messages: { content: string }[]) => { digestPrompt = messages[1].content; return { json: { working: ["There was 1 run."], not_working: [] } }; } } } as unknown as Roots);
    const response = await app.request("/api/insights?window=7d");
    expect(response.status).toBe(200);
    const insights = await response.json() as { passing: { check_id: string }[] };
    expect.soft(insights.passing.some((c) => c.check_id === check.id)).toBe(active);
    const digest = await app.request("/api/insights/digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ window: "7d" }) });
    expect(digest.status).toBe(200);
    expect.soft(digestPrompt.includes("Reported check")).toBe(active);
    expect(store.getMeta(`approved_mcp:${check.id}`)).toBe(grant);
    expect(registry.pendingMcpCheck(check.id)?.revision).toBe(proposal.revision);
  } finally { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});