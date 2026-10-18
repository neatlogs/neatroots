import { afterEach, describe, expect, it } from "vitest";
import { hex, makeRoots, type TestRoots } from "./helpers.js";

// Attribute keys come from whoever sends a trace. A key such as `gen_ai.prompt.0.__proto__.x`
// must stay data: it must not reach the global Object prototype or fake other attributes.

let tb: TestRoots | undefined;
afterEach(async () => {
  await tb?.close();
  tb = undefined;
  for (const k of ["polluted", "polluted_kv", "polluted_json"]) delete (Object.prototype as Record<string, unknown>)[k];
});

const str = (key: string, v: string) => ({ key, value: { stringValue: v } });

describe("trace attribute keys", () => {
  it("can't pollute the global prototype or fake attributes, and the server keeps working", async () => {
    tb = await makeRoots({ serve: true, noEngine: true });
    const traceId = hex(16);
    const now = String(BigInt(Date.now()) * 1_000_000n);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [str("service.name", "pp-test")] },
          scopeSpans: [
            {
              scope: { name: "t" },
              spans: [
                {
                  traceId,
                  spanId: hex(8),
                  name: "chat",
                  kind: 3,
                  startTimeUnixNano: now,
                  endTimeUnixNano: now,
                  attributes: [
                    str("gen_ai.system", "openai"),
                    str("neatlogs.span.kind", "llm"),
                    // A dotted key walked into nested objects.
                    str("gen_ai.prompt.0.__proto__.polluted", "PWNED"),
                    str("gen_ai.prompt.0.role", "user"),
                    // A top-level `__proto__` attribute whose value tries to supply other attributes.
                    { key: "__proto__", value: { kvlistValue: { values: [str("gen_ai.request.model", "spoofed-model"), str("polluted_kv", "x")] } } },
                    // A message given as JSON that carries `__proto__`.
                    str("gen_ai.prompt.1", JSON.stringify({ role: "user", content: "hi", ["__proto__"]: { polluted_json: "y" } })),
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    const r = await fetch(`${tb.url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);

    const blank: Record<string, unknown> = {};
    expect(blank.polluted).toBeUndefined();
    expect(blank.polluted_kv).toBeUndefined();
    expect(blank.polluted_json).toBeUndefined();

    const run = await (await fetch(`${tb.url}/api/runs/${traceId}`)).json();
    expect(run.run.trace_id).toBe(traceId);
    // The model wasn't faked through the `__proto__` attribute.
    expect(JSON.stringify(run)).not.toContain("spoofed-model");

    // The process still works end to end (a polluted prototype broke the database and MCP).
    const mcp = await fetch(`${tb.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(mcp.status).toBe(200);
  });
});
