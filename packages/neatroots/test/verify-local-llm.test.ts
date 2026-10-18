import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { localEndpoint, verifyLocalLlm } from "../scripts/verify-local-llm.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function server(mode = "ok") {
  const seen: any[] = [];
  const s = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const b = text ? JSON.parse(text) : undefined; seen.push({ url: req.url, body: b, headers: req.headers });
    res.setHeader("content-type", "application/json");
    if (mode === "slow") return;
    if (mode === "redirect") { res.writeHead(302, { location: "http://example.com/v1/models" }); res.end(); return; }
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: mode === "missing" ? [] : [{ id: "mock-model" }] })); return; }
    if (mode === "downgrade" && b.response_format?.json_schema?.strict) {
      res.writeHead(422); res.end('{"error":{"message":"strict json_schema unsupported"}}'); return;
    }
    res.end(JSON.stringify({ model: "mock-model", choices: [{ message: { content: b.response_format ? '{"answer":"yes"}' : "yes" },
      ...(b.logprobs && mode !== "no-logprobs" ? { logprobs: { content: [{
        token: mode === "missing-selected-token" ? undefined : "yes",
        logprob: mode === "positive-selected" ? 0.5 : -0.1,
        top_logprobs: [{ token: mode === "missing-top-token" ? undefined : "yes", logprob: mode === "positive-top" ? 0.5 : -0.1 }],
      }] } } : {}),
    }] }));
  });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }));
  return { endpoint: `http://127.0.0.1:${(s.address() as any).port}/v1`, seen };
}

it("rejects absent, remote, credentialed and ambiguous endpoints before sending requests", () => {
  for (const value of ["", "https://localhost/v1", "http://example.com/v1", "http://127.0.0.1.evil/v1", "http://user:secret@localhost/v1", "http://localhost/v1?key=secret", "http://localhost/v1#key", "http://localhost/"]) {
    expect(() => localEndpoint(value)).toThrow();
  }
  expect(localEndpoint("http://localhost:8000/v1/").href).toBe("http://127.0.0.1:8000/v1");
});

it("observes models, auto selection, explicit model, schema and token logprobs through LlmClient", async () => {
  const s = await server();
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock fixture" });
  expect(report.passed).toBe(true);
  expect(report.checks.auto.detail).toEqual({ resolvedModel: "mock-model" });
  expect(report.requests.filter(r => r.method === "POST")).toHaveLength(3);
  expect(s.seen.every(r => !r.headers.authorization)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("messages");
  expect(report.kind).toBe("local-endpoint-observation");
});

it("records the actual strict-schema downgrade without changing the production transport", async () => {
  const s = await server("downgrade");
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock fixture" });
  expect(report.passed).toBe(true);
  const attempts = report.requests.filter(r => r.phase === "jsonSchema");
  expect(attempts.map(a => a.status)).toEqual([422, 200]);
  expect(attempts.map(a => (a.parameters?.response_format as any).json_schema.strict)).toEqual([true, false]);
});

it("does not call missing logprobs a compatibility pass", async () => {
  const s = await server("no-logprobs");
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock fixture" });
  expect(report.checks.chat.passed).toBe(true);
  expect(report.checks.logprobs.passed).toBe(false);
  expect(report.passed).toBe(false);
});

it.each(["positive-selected", "positive-top", "missing-selected-token", "missing-top-token"])("rejects invalid logprobs: %s", async mode => {
  const s = await server(mode);
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock fixture" });
  expect(report.checks.logprobs.passed).toBe(false);
  expect(report.passed).toBe(false);
});

it.each(["missing", "redirect", "slow"] as const)("fails boundedly on %s without attempting chat", async mode => {
  const s = await server(mode);
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock fixture", timeoutMs: 150 });
  expect(report.passed).toBe(false);
  expect(s.seen.every(r => r.url === "/v1/models")).toBe(true);
  expect(report.requests.length).toBeLessThanOrEqual(1);
});
