import http from "node:http";
import type net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, type RootsConfig } from "../src/config.js";
import { LlmClient, LlmUnavailableError } from "../src/models/llm.js";
import { LlmDecisionBackend } from "../src/models/decision.js";
import { strictSchema } from "../src/models/providers.js";
import { applyExternalLlm } from "../src/server/api-models.js";
import "./helpers.js";

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}

/** A tiny HTTP server that records requests and answers with the handler's result. */
async function mock(handler: (req: Seen) => { status?: number; json: unknown }): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s: Seen = { path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(s);
      const r = handler(s);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function cfgWith(fn: (c: RootsConfig["llm"]) => void): RootsConfig["llm"] {
  const c = defaultConfig().llm;
  c.baseUrl = "http://127.0.0.1:9/v1";
  c.model = "local-model";
  fn(c);
  return c;
}

const chatReply = (text: string) => ({ choices: [{ message: { content: text } }], model: "remote-model", usage: { prompt_tokens: 3, completion_tokens: 2 } });
const claudeReply = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
  ...extra,
});
const schema = { name: "x", schema: { type: "object", properties: { ok: { type: "boolean" }, tags: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["ok"] } };

describe("strictSchema", () => {
  it("closes objects, drops unsupported constraints, and can require every property", () => {
    const s = strictSchema({ type: "object", properties: { a: { type: "object", additionalProperties: { type: "string" } }, b: { type: "array", minItems: 3, items: { type: "string" } } }, required: ["b"] }, { allRequired: true });
    expect(s).toEqual({
      type: "object",
      properties: { a: { type: "object", properties: {}, additionalProperties: false, required: [] }, b: { type: "array", items: { type: "string" } } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });
});

describe("hosted OpenAI-compatible provider", () => {
  it("sends the stored key, strips secrets, adapts to a stricter server and reports where it ran", async () => {
    let rejected = false;
    const srv = await mock((r) => {
      if (r.path.endsWith("/models")) return { json: { data: [{ id: "remote-model" }] } };
      if (r.body.response_format?.json_schema?.strict && !rejected) {
        rejected = true;
        return { status: 400, json: { error: { message: "strict json_schema is not supported" } } };
      }
      return { json: chatReply('{"ok": true}') };
    });
    closers.push(srv.close);
    const llm = new LlmClient(
      cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "custom", baseUrl: `${srv.url}/v1`, model: "remote-model" })),
      { secret: async (n) => (n === "llm-api-key-custom" ? "test-key-123456" : undefined) },
    );
    const r = await llm.chat([{ role: "user", content: "token sk-ant-abcdefghijklmnopqrstuvwxyz0123 here" }], { schema, maxTokens: 24 });
    expect(r.json).toEqual({ ok: true });
    expect(r.where).toBe("custom");
    const calls = srv.seen.filter((s) => s.path.endsWith("/chat/completions"));
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.authorization).toBe("Bearer test-key-123456");
    expect(calls[0].body.messages[0].content).toContain("[redacted:api_key]");
    expect(calls[0].body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(calls[0].body.response_format.json_schema.schema.properties.tags.minItems).toBeUndefined();
    expect(calls[1].body.response_format.json_schema.strict).toBe(false);
  });

  it("falls back to the local LLM when the provider rejects the key", async () => {
    const remote = await mock(() => ({ status: 401, json: { error: "bad key" } }));
    const local = await mock((r) => (r.path.endsWith("/models") ? { json: { data: [{ id: "local-model" }] } } : { json: { ...chatReply("local answer"), model: "local-model" } }));
    closers.push(remote.close, local.close);
    const llm = new LlmClient(
      cfgWith((c) => {
        c.baseUrl = `${local.url}/v1`;
        Object.assign(c.external, { enabled: true, provider: "custom", baseUrl: `${remote.url}/v1`, model: "m" });
      }),
      { secret: async () => "test-key-123456" },
    );
    const r = await llm.chat([{ role: "user", content: "hi" }]);
    expect(r.where).toBe("local");
    expect(r.text).toBe("local answer");
  });

  it("does not fall back when fallback is off", async () => {
    const remote = await mock(() => ({ status: 401, json: { error: "bad key" } }));
    closers.push(remote.close);
    const llm = new LlmClient(
      cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "custom", baseUrl: `${remote.url}/v1`, model: "m", fallbackToLocal: false })),
      { secret: async () => "test-key-123456" },
    );
    await expect(llm.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("Anthropic provider", () => {
  it("calls the Messages API with structured output, low effort for short answers, and refusal fallbacks", async () => {
    const srv = await mock(() => ({ json: claudeReply('{"ok": true}') }));
    closers.push(srv.close);
    const llm = new LlmClient(
      cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "anthropic", baseUrl: srv.url, model: "claude-opus-5-5" })),
      { secret: async (n) => (n === "llm-api-key-anthropic" ? "sk-ant-test-key-0000000000000000" : undefined) },
    );
    const r = await llm.chat([{ role: "system", content: "Reply with JSON only." }, { role: "user", content: "ping" }], { schema, maxTokens: 24 });
    expect(r.json).toEqual({ ok: true });
    expect(r.where).toBe("anthropic");
    const req = srv.seen[0];
    expect(req.path).toContain("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-test-key-0000000000000000");
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.system).toBe("Reply with JSON only.");
    expect(req.body.output_config.effort).toBe("low");
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.format.schema.additionalProperties).toBe(false);
    expect(req.body.thinking).toBeUndefined();
  });

  it("drops an option an older model rejects and retries", async () => {
    const srv = await mock((r) =>
      r.body.output_config?.effort ? { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "effort is not supported on this model" } } } : { json: claudeReply("plain") },
    );
    closers.push(srv.close);
    const llm = new LlmClient(cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "anthropic", baseUrl: srv.url, model: "claude-haiku-4-5" })), {
      secret: async () => "sk-ant-test-key-0000000000000000",
    });
    const r = await llm.chat([{ role: "user", content: "hi" }]);
    expect(r.text).toBe("plain");
    expect(srv.seen).toHaveLength(2);
    expect(srv.seen[0].body.fallbacks).toBeUndefined();
  });

  it("reports a refusal as an error, not as an answer", async () => {
    const srv = await mock(() => ({ json: claudeReply("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }) }));
    closers.push(srv.close);
    const llm = new LlmClient(cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "anthropic", baseUrl: srv.url, model: "claude-opus-5-5", fallbackToLocal: false })), {
      secret: async () => "sk-ant-test-key-0000000000000000",
    });
    await expect(llm.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/declined.*cyber/);
  });

  it("an answer that can't be read fails the check instead of counting as yes (#23.18)", async () => {
    const srv = await mock(() => ({ json: claudeReply("Yes, I think the agent probably did.") }));
    closers.push(srv.close);
    const llm = new LlmClient(cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "anthropic", baseUrl: srv.url, model: "claude-opus-5-5" })), {
      secret: async () => "sk-ant-test-key-0000000000000000",
    });
    await expect(new LlmDecisionBackend(llm).decide("evidence", [{ name: "q", type: "yes_no", ask: "Did it fail?" }])).rejects.toThrow(/couldn't be read/);
  });

  it("decisions ask Claude for a confidence, since it gives no logprobs", async () => {
    const srv = await mock(() => ({ json: claudeReply('{"answer": "yes", "confidence": 0.95}') }));
    closers.push(srv.close);
    const llm = new LlmClient(cfgWith((c) => Object.assign(c.external, { enabled: true, provider: "anthropic", baseUrl: srv.url, model: "claude-opus-5-5" })), {
      secret: async () => "sk-ant-test-key-0000000000000000",
    });
    const r = await new LlmDecisionBackend(llm).decide("evidence", [{ name: "q", type: "yes_no", ask: "Did it fail?" }]);
    expect(r.answers.q.probability).toBeCloseTo(0.86, 2); // its stated 0.95, pulled toward even odds (uncalibrated)
    expect(srv.seen[0].body.output_config.format.schema.required).toEqual(["answer", "confidence"]);
  });
});

describe("applyExternalLlm", () => {
  it("resets the model on a provider switch and validates input", () => {
    const e = defaultConfig().llm.external;
    expect(applyExternalLlm(e, { provider: "openai" })).toBeUndefined();
    expect(e.model).toBe("");
    expect(applyExternalLlm(e, { enabled: true })).toMatch(/model/);
    expect(applyExternalLlm(e, { provider: "nope" })).toMatch(/provider must be/);
    expect(applyExternalLlm(e, { redact: "some" })).toMatch(/redact/);
    const c = defaultConfig().llm.external;
    const before = { ...c };
    expect(applyExternalLlm(c, { provider: "custom", model: "m", enabled: true })).toMatch(/base URL/);
    expect(c).toEqual(before);
    expect(applyExternalLlm(c, { provider: "custom", model: "m", base_url: "http://localhost:8080/v1", enabled: true })).toBeUndefined();
  });
});

describe("the LLM queue", () => {
  it("serves interactive calls before queued background ones, and drops calls cancelled while waiting", async () => {
    const order: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
          return;
        }
        order.push(String(JSON.parse(raw).messages.at(-1).content));
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(chatReply("ok")));
        }, 60);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const llm = new LlmClient(cfgWith((c) => Object.assign(c, { baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true })), { secret: async () => undefined });

    const background = ["bg1", "bg2", "bg3"].map((t) => llm.chat([{ role: "user", content: t }], { priority: "high" }));
    const ac = new AbortController();
    const cancelled = llm.chat([{ role: "user", content: "cancelled" }], { priority: "high", signal: ac.signal });
    const interactive = llm.chat([{ role: "user", content: "person waiting" }], { priority: "interactive" });
    ac.abort();
    await expect(cancelled).rejects.toThrow(/cancelled before the model started/);
    await Promise.all([...background, interactive]);
    expect(order.indexOf("person waiting")).toBeLessThan(order.indexOf("bg2"));
    expect(order).not.toContain("cancelled");
  });
});
