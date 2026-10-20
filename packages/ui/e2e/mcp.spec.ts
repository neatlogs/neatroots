import { expect, test } from "@playwright/test";
import { open, state } from "./util";

/** Calls one MCP tool over neatroots' streamable HTTP endpoint, as a coding agent would. */
async function callTool(name: string, args: Record<string, unknown>) {
  const url = `${state().url}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id");
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
  return res.text();
}

test.describe("coding agent tools", () => {
  test("show_in_ui opens the run the agent is talking about", async ({ page }) => {
    await open(page, "home");
    await callTool("show_in_ui", { trace_id: state().researchRun, view: "timeline" });
    await expect(page).toHaveURL(new RegExp(`#/runs/${state().researchRun}\\?view=timeline`));
    await expect(page.getByTestId("timeline")).toBeVisible();
  });

  test("query_sql answers from the local store", async () => {
    const text = await callTool("query_sql", { sql: `SELECT project, COUNT(*) AS n FROM runs WHERE trace_id IN ('${state().supportRun}', '${state().secondTurn}') GROUP BY project` });
    expect(text).toMatch(/\\"project\\": \\"e2e-support\\"/);
    expect(text).toMatch(/\\"n\\": 2/);
  });
});
