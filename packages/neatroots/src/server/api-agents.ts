import type { Hono } from "hono";
import { connectClient, disconnectClient, findClient, listClients, manualSnippet, serverCommand } from "../mcp/clients.js";
import { err } from "./util.js";

/** Coding agents: which are on this machine, which can read neatroots over MCP, and one-click connect. */
export function mountAgentsApi(app: Hono): void {
  app.get("/api/agents", (c) => {
    const cmd = serverCommand();
    return c.json({ command: [cmd.command, ...cmd.args], agents: listClients() });
  });

  app.get("/api/agents/:id/snippet", (c) => {
    const client = findClient(c.req.param("id"));
    return client ? c.json({ snippet: manualSnippet(client) }) : err(c, 404, "unknown agent");
  });

  app.post("/api/agents/:id/:action", (c) => {
    const client = findClient(c.req.param("id"));
    if (!client) return err(c, 404, "unknown agent");
    const action = c.req.param("action");
    if (action !== "connect" && action !== "disconnect") return err(c, 404, "unknown action");
    const r = action === "connect" ? connectClient(client) : disconnectClient(client);
    if (!r.ok) return c.json({ ...r, error: r.message }, 422);
    return c.json({ ...r, note: action === "connect" ? (client.note ?? null) : null });
  });
}
