import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LlmClient } from "../src/models/llm.js";
import { batch, hex, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

// A saved redaction pattern that can't be applied must stop the send, never let the data it
// should remove leave the machine. Patterns saved before nested repeats were refused (#40) keep
// redacting as they did in 0.2.8.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A local stand-in for Neatlogs Cloud or a hosted LLM that counts the requests it gets. */
async function sink(): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => n };
}

async function roots(patterns: string[], output: string): Promise<{ tb: TestRoots; t: string }> {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  tb.roots.config.cloud.redactPatterns = patterns;
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([toolSpan(t, root, "lookup_host", "{}", output), span({ traceId: t, spanId: root, name: "agent", kind: "workflow", attrs: [s("neatlogs.session.id", "s1")] })])]);
  return { tb, t };
}

describe("saved redaction patterns", () => {
  it("keep redacting a pattern saved before nested repeats were refused", async () => {
    const { tb, t } = await roots(["(\\w+\\.)+internal\\.example"], "connected to db1.prod.internal.example");
    const preview = await tb.roots.relay.preview([t]);
    expect(preview.redactions.find((k) => k.kind === "custom")?.count ?? 0).toBeGreaterThan(0);
  });

  it("stop a forward and the preview when a pattern isn't a valid regex", async () => {
    const { tb, t } = await roots(["("], "nothing secret");
    const cloud = await sink();
    const row = await tb.roots.relay.forward([t], "test", { endpoint: cloud.url, apiKey: "nl-test-key" });
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/isn't a valid regular expression.*nothing was sent/);
    expect(cloud.requests()).toBe(0);
    const preview = await fetch(`${tb.url}/api/cloud/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trace_ids: [t] }) });
    expect(preview.status).toBe(400);
    expect((await preview.json()).error).toMatch(/nothing was sent/);
  });

  it("stop a forward when a pattern runs too long, instead of sending unredacted", async () => {
    const { tb, t } = await roots(["(a|aa)+$"], "a".repeat(40) + "!");
    const cloud = await sink();
    const started = Date.now();
    const row = await tb.roots.relay.forward([t], "test", { endpoint: cloud.url, apiKey: "nl-test-key" });
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/took longer than .* nothing was sent/);
    expect(cloud.requests()).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("keep text from a hosted LLM when a pattern can't be applied", async () => {
    const hosted = await sink();
    const cfg = defaultConfig().llm;
    cfg.baseUrl = "http://127.0.0.1:9/v1";
    Object.assign(cfg.external, { enabled: true, provider: "anthropic", baseUrl: hosted.url, model: "claude-haiku-4-5", redact: "all", fallbackToLocal: false });
    const llm = new LlmClient(cfg, { secret: async () => "sk-ant-test-key-0000000000000000", redactPatterns: () => ["("] });
    await expect(llm.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/nothing was sent/);
    expect(hosted.requests()).toBe(0);
  });
});
