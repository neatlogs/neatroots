import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);

it.each(["modern", "old", "malformed", "failed"])("doctor preserves probe cleanup and exit status with %s optional coverage", async mode => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-doctor-coverage-"));
  let trace = "", deleted = false, requestedAfterDelete = false;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    let response: unknown = {};
    if (req.url === "/health") response = { ok: true };
    else if (req.url === "/v1/models") response = { data: [{ id: "mock" }] };
    else if (req.url === "/api/status") response = { check_errors: [], engine: { llm: { ok: true, model: "mock", where: "local" }, decision: { backend: "llm", model: "mock" } }, classifier: { laya: { state: "missing", consent: "no" }, jev_cloud: { enabled: false, has_key: false } } };
    else if (req.url === "/v1/traces") trace = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0].traceId;
    else if (req.url?.startsWith("/api/traces/v3/")) response = { _id: trace, spanCount: 1 };
    else if (req.method === "DELETE" && req.url === `/api/runs/${trace}`) deleted = true;
    else if (req.url === "/api/audit/status") {
      requestedAfterDelete = deleted;
      if (mode === "old") res.statusCode = 404;
      if (mode === "failed") res.statusCode = 500;
      response = { coverage: mode === "malformed" ? { scope: "bad" } : { scope: "current_local_store", observed_runs: 3, traced_runs: 2, imported_runs: 1, unclassified_runs: 0, guidance_delivered_runs: 1, connections: { state: "unavailable" } } };
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(home, "config.yaml"), `llm:\n  baseUrl: http://127.0.0.1:${port}/v1\n  model: mock\nclassifier:\n  laya:\n    enabled: false\n`);
  try {
    const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve(import.meta.dirname, "../src/cli.ts"), "doctor", "--port", String(port)], {
      env: { ...process.env, NEATROOTS_HOME: home, HOME: home, USERPROFILE: home }, timeout: 15000,
    });
    expect(deleted).toBe(true); expect(requestedAfterDelete).toBe(true);
    expect(result.stdout).toContain("trace round trip through /v1/traces");
    expect(result.stdout).toContain(mode === "modern" ? "2 received, 1 imported, 0 unknown" : "audit coverage unavailable");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20000);
