import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LlmClient } from "../src/models/llm.js";
import { localEndpoint, verifyLocalLlm } from "../scripts/verify-local-llm.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

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
  expect(report.timeoutMs).toBe(45_000);
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

it("uses the selected budget for every chat instead of a hidden ten-second cap", async () => {
  const s = await server();
  const chat = vi.spyOn(LlmClient.prototype, "chat");
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock", timeoutMs: 12_000 });
  expect(report.passed).toBe(true);
  expect(chat).toHaveBeenCalledTimes(3);
  for (const [, options] of chat.mock.calls) expect(options?.timeoutSec).toBe(12);
  expect(report.timeoutMs).toBe(12_000);
});

it("keeps the shared deadline across chat phases", async () => {
  const s = await server();
  vi.spyOn(LlmClient.prototype, "chat").mockImplementation(async (_messages, options) => {
    await new Promise<void>(resolve => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("deadline");
  });
  const start = Date.now();
  const report = await verifyLocalLlm({ endpoint: s.endpoint, model: "mock-model", runtime: "mock", timeoutMs: 150 });
  expect(report.passed).toBe(false);
  expect(Date.now() - start).toBeLessThan(1500);
  expect(report.checks.logprobs.passed).toBe(false);
});

it.each([99, 45001, 600000, Infinity, NaN, 100.5])("rejects invalid API timeout %s", async timeoutMs => {
  await expect(verifyLocalLlm({ endpoint: "http://127.0.0.1:1/v1", model: "mock", runtime: "mock", timeoutMs })).rejects.toThrow("100..45000");
});

it.each(["99", "45001", "600000", "NaN", "Infinity", "100.5", "invalid"])("rejects invalid CLI timeout %s", timeout => {
  const script = fileURLToPath(new URL("../scripts/verify-local-llm.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "tsx", script, "--endpoint", "http://127.0.0.1:1/v1", "--model", "mock", "--runtime", "mock", "--timeout-ms", timeout], { encoding: "utf8", timeout: 5000 });
  expect(child.status).toBe(2);
  expect(child.stdout).toBe("");
});

it.each([
  ["--model", "mock-model", "--runtime", "--timeout-ms"],
  ["--runtime", "--model", "--model", "mock-model"],
  ["--model", "--runtime", "--runtime", "mock"],
  ["--model", "mock-model", "--runtime", "-"],
  ["--model", "mock-model", "--runtime"],
  ["--model", "mock-model", "--runtime", "mock", "--timeout-ms", "--help"],
  ["--model", "mock-model", "--runtime", "mock", "--runtime", "duplicate"],
])("rejects missing or duplicate operands before any endpoint request: %j", async (...args) => {
  const s = await server();
  const script = fileURLToPath(new URL("../scripts/verify-local-llm.ts", import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, "--endpoint", s.endpoint, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", data => { stdout += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI did not reject invalid operands promptly")); }, 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout }); });
  });
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(s.seen).toEqual([]);
});
