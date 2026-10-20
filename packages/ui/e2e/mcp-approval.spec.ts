import { createServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { expect, test } from "@playwright/test";
import { open, state } from "./util";

async function propose(check: string) {
  const url = `${state().url}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "approval-e2e", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  try {
    await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const result = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_check", arguments: { check } } }) });
    expect(result.ok).toBe(true);
    await result.text();
  } finally {
    if (session) await fetch(url, { method: "DELETE", headers: h });
  }
}

test("a real MCP proposal activates only after approval in the app", async ({ page }, testInfo) => {
  const id = `approval-e2e-${testInfo.repeatEachIndex}-${Date.now()}`;
  const list = async () => (await page.request.get(`${state().url}/api/checks`)).json();
  try {
    const eventsReady = page.waitForResponse((response) => response.url().endsWith("/api/events") && response.ok());
    await open(page, "checks");
    await eventsReady;
    expect((await list()).pending_mcp_checks.some((c: { id: string }) => c.id === id)).toBe(false);
    await propose(`id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 2 }\n`);
    const pending = await list();
    expect(pending.checks.some((c: { id: string }) => c.id === id)).toBe(false);
    expect(pending.pending_mcp_checks.some((c: { id: string }) => c.id === id)).toBe(true);
    const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
    await expect(proposal).toBeVisible();
    await proposal.getByRole("button", { name: "Approve check" }).click();
    await expect(proposal).toHaveCount(0);
    await expect.poll(async () => (await list()).checks.find((c: { id: string }) => c.id === id)?.source).toBe("mcp");
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: id })).toBeVisible();
  } finally {
    const pending = (await list()).pending_mcp_checks?.find((c: { id: string }) => c.id === id);
    if (pending) await page.request.post(`${state().url}/api/checks/${id}/reject`, { data: { revision: pending.revision } });
    await page.request.delete(`${state().url}/api/checks/${id}`);
  }
});

test("mounted Checks recovers MCP proposals missed during an SSE disconnection", async ({ page }, testInfo) => {
  const id = `reconnect-e2e-${testInfo.repeatEachIndex}-${Date.now()}`;
  const list = async () => (await page.request.get(`${state().url}/api/checks`)).json();
  const streams = new Set<ServerResponse>();
  let disconnected = false;
  // Forward the real event stream through a socket we can sever independently of HTTP/MCP.
  const proxy = createServer(async (_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (disconnected) {
      response.writeHead(503).end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => { streams.delete(response); controller.abort(); });
    try {
      const upstream = await fetch(`${state().url}/api/events`, { signal: controller.signal });
      response.writeHead(upstream.status, { "Content-Type": "text/event-stream" });
      streams.add(response);
      Readable.fromWeb(upstream.body!).on("error", () => response.destroy()).pipe(response);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as { port: number };
  await page.route("**/api/events", (route) => route.continue({ url: `http://127.0.0.1:${address.port}/api/events` }));
  try {
    await open(page, "checks");
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search checks" })).toBeVisible();
    const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
    disconnected = true;
    for (const stream of streams) stream.destroy();
    await expect(page.getByText("reconnecting…", { exact: true })).toBeVisible();
    await propose(`id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 2 }\n`);
    expect((await list()).pending_mcp_checks.some((c: { id: string }) => c.id === id)).toBe(true);
    await expect(proposal).toHaveCount(0);
    disconnected = false;
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(proposal).toBeVisible();
  } finally {
    await page.close();
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    const pending = (await list()).pending_mcp_checks?.find((c: { id: string }) => c.id === id);
    if (pending) await fetch(`${state().url}/api/checks/${id}/reject`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: pending.revision }),
    });
  }
});

test("Checks reconciles proposals created before the first SSE subscription", async ({ page }, testInfo) => {
  const id = `first-open-${testInfo.repeatEachIndex}-${Date.now()}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/events", async (route) => { await gate; await route.continue(); });
  try {
    const initialChecks = page.waitForResponse((r) => r.url().endsWith("/api/checks") && r.ok());
    await open(page, "checks");
    await initialChecks;
    await expect(page.getByRole("textbox", { name: "Search checks" })).toBeVisible();
    await propose(`id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 2 }\n`);
    const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
    await expect(proposal).toHaveCount(0);
    release();
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(proposal).toBeVisible();
  } finally {
    release();
    const data = await (await page.request.get(`${state().url}/api/checks`)).json();
    const pending = data.pending_mcp_checks.find((c: { id: string }) => c.id === id);
    if (pending) await page.request.post(`${state().url}/api/checks/${id}/reject`, { data: { revision: pending.revision } });
  }
});

test("an existing MCP edit requires explicit manual review and save, then separate rejection", async ({ page }, testInfo) => {
  const id = `manual-e2e-${testInfo.repeatEachIndex}-${Date.now()}`;
  const list = async () => (await page.request.get(`${state().url}/api/checks`)).json();
  try {
    await page.request.post(`${state().url}/api/checks`, { data: { yaml: `id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 9 }\n` } });
    await propose(`id: ${id}\nkind: rule\naction: flag\nrule: { type: count, at_least: 2 }\n`);
    const pending = (await list()).pending_mcp_checks.find((c: { id: string }) => c.id === id);
    expect(pending.manual_application_required).toBe(true);
    await open(page, "checks");
    const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
    await expect(proposal.getByRole("button", { name: "Approve check" })).toHaveCount(0);
    await proposal.getByRole("button", { name: "Review manually" }).click();
    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("textbox", { name: "Check (YAML)" })).toHaveValue(/at_least: 2/);
    await expect(editor.getByText(/takes human ownership/)).toBeVisible();
    expect((await list()).checks.find((c: { id: string }) => c.id === id).check.rule.at_least).toBe(9);
    await editor.getByRole("button", { name: "Save check", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(proposal).toBeVisible();
    const saved = await list();
    expect(saved.checks.find((c: { id: string }) => c.id === id)).toMatchObject({ source: "user", check: { rule: { at_least: 2 } } });
    expect(saved.pending_mcp_checks.find((c: { id: string }) => c.id === id).revision).toBe(pending.revision);
    await proposal.getByRole("button", { name: "Reject check" }).click();
    await expect(proposal).toHaveCount(0);
  } finally {
    const pending = (await list()).pending_mcp_checks.find((c: { id: string }) => c.id === id);
    if (pending) await page.request.post(`${state().url}/api/checks/${id}/reject`, { data: { revision: pending.revision } });
    await page.request.delete(`${state().url}/api/checks/${id}`);
  }
});
