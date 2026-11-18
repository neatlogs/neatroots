import { afterEach, describe, expect, it } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

// Another site must not be able to frame the app and click through its actions (clickjacking).

let tb: TestRoots | undefined;
afterEach(async () => {
  await tb?.close();
  tb = undefined;
});

const framed = (r: Response) => ({
  csp: r.headers.get("content-security-policy"),
  xfo: r.headers.get("x-frame-options"),
  nosniff: r.headers.get("x-content-type-options"),
});
const DENIED = { csp: "frame-ancestors 'none'", xfo: "DENY", nosniff: "nosniff" };

describe("frame headers", () => {
  it("forbid framing on the app, the API, MCP, ingest and refusals", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const { url } = tb;
    const app = await fetch(`${url}/runs`);
    expect(framed(app)).toEqual(DENIED);
    expect(framed(await fetch(`${url}/api/status`))).toEqual(DENIED);
    const mcp = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(mcp.status).toBeLessThan(500);
    expect(framed(mcp)).toEqual(DENIED);
    const ingest = await fetch(`${url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "agent" }) });
    expect(ingest.status).toBe(200);
    expect(framed(ingest)).toEqual(DENIED);
    const refused = await fetch(`${url}/api/status`, { headers: { origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    expect(framed(refused)).toEqual(DENIED);
  });
});
