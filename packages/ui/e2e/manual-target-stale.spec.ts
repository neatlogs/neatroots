import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { open, state } from "./util";

async function propose(check: string) {
  const url = `${state().url}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stale-target-e2e", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id"); await init.text();
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  try {
    await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const result = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_check", arguments: { check } } }) });
    expect(result.ok).toBe(true); await result.text();
  } finally { if (session) await fetch(url, { method: "DELETE", headers: h }); }
}

for (const mode of ["removed-project", "user-default"] as const) {
  test(`manual review preserves the exact ${mode} target through the real save API`, async ({ page }, info) => {
    const id = `stale-target-${mode}-${info.repeatEachIndex}-${Date.now()}`;
    const yaml = (count: number) => `id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: ${count} }\n`;
    const list = async () => (await page.request.get(`${state().url}/api/checks`)).json();
    const projectDir = path.join(state().home, `removed-${id}`), projectFile = path.join(projectDir, "shared.yaml");
    let payload: unknown;
    try {
      expect((await page.request.post(`${state().url}/api/checks`, { data: { yaml: yaml(9) } })).ok()).toBe(true);
      await propose(yaml(2));
      const before = await list(), pending = before.pending_mcp_checks.find((p: { id: string }) => p.id === id);
      const userFile = before.checks.find((c: { id: string }) => c.id === id).path as string;
      const userBytes = fs.readFileSync(userFile);
      fs.mkdirSync(projectDir); fs.writeFileSync(projectFile, yaml(7));
      const projectBytes = fs.readFileSync(projectFile);
      const dir = mode === "removed-project" ? projectDir : pending.target_dir;
      const target = mode === "removed-project" ? projectFile : pending.target_path;
      // Simulate a retained browser proposal from before project removal. The server really has
      // no registration for this directory, and handles POST itself (no mocked save response).
      await page.route("**/api/checks", async (route) => {
        if (route.request().method() === "POST") { payload = route.request().postDataJSON(); return route.continue(); }
        const response = await route.fetch(); const data = await response.json();
        if (mode === "removed-project") {
          data.project_dirs = [];
          data.pending_mcp_checks = data.pending_mcp_checks.map((p: { id: string }) => p.id === id ? { ...p, target_dir: dir, target_path: target } : p);
        }
        await route.fulfill({ response, json: data });
      });
      await open(page, "checks");
      const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
      await proposal.getByRole("button", { name: "Review manually" }).click();
      const editor = page.getByRole("dialog");
      await expect(editor.getByText(target, { exact: true })).toBeVisible();
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/checks") && r.request().method() === "POST");
      await editor.getByRole("button", { name: "Save check", exact: true }).click();
      const response = await saved;
      expect.soft(payload).toEqual({ yaml: pending.yaml, dir, manual_target_path: target });
      expect.soft(response.status()).toBe(mode === "removed-project" ? 400 : 200);
      if (mode === "removed-project") {
        await expect(editor).toBeVisible();
        await expect(editor.getByRole("textbox", { name: "Check (YAML)" })).toHaveValue(pending.yaml);
        await expect(page.getByText(/Couldn't save the check:.*registered project checks directory/)).toBeVisible();
        expect(fs.readFileSync(userFile)).toEqual(userBytes);
        expect(fs.readFileSync(projectFile)).toEqual(projectBytes);
      } else {
        await expect(editor).toHaveCount(0);
        expect((await list()).checks.find((c: { id: string }) => c.id === id)).toMatchObject({ source: "user", path: userFile, check: { rule: { at_least: 2 } } });
        expect(fs.readFileSync(projectFile)).toEqual(projectBytes);
      }
      expect((await list()).pending_mcp_checks.find((p: { id: string }) => p.id === id).revision).toBe(pending.revision);
      if (mode === "removed-project") await editor.getByRole("button", { name: "Close" }).click();
      await expect(proposal).toBeVisible();
    } finally {
      const pending = (await list()).pending_mcp_checks.find((p: { id: string }) => p.id === id);
      if (pending) await page.request.post(`${state().url}/api/checks/${id}/reject`, { data: { revision: pending.revision } });
      await page.request.delete(`${state().url}/api/checks/${id}`);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
}