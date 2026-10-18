// Run with: pnpm --filter @neatlogs/neatroots exec tsx ../../examples/python-pydanticai/smoke.mjs
// Real PydanticAI + local model + HTTP/gRPC collector, with no hosted requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Roots, createApp, startServer } from "../../packages/neatroots/dist/index.js";
import { startGrpc } from "../../packages/neatroots/src/ingest/grpc.ts";
import { startMockLlm } from "../../packages/neatroots/src/dev/mock-llm.ts";
import { defaultConfig } from "../../packages/neatroots/src/config.ts";
import { checkCoverage } from "../../packages/neatroots/src/server/coverage.ts";
import { modelChecksComplete } from "./smoke-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = process.env.SMOKE_OUTPUT;
const receipt = { kind: "local-mock-integration", interpreterOverride: process.env.SMOKE_PYTHON ?? null, scenarios: [], trapRequests: 0 };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pydanticai-smoke-"));
const port = () => new Promise(resolve => {
  const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const close = s => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Owned server did not close within 5 seconds")), 5000);
  s.closeAllConnections?.(); s.close(() => { clearTimeout(timer); resolve(); });
});
const run = (args, env) => new Promise((resolve, reject) => {
  const python = process.env.SMOKE_PYTHON;
  const child = spawn(python || "uv", python ? args.slice(2) : args, { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", timedOut = false;
  child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => { clearTimeout(timer); resolve({ code, output: timedOut ? `Agent timed out after 60000ms (SIGKILL)\n${output}` : output }); });
});
let roots, web, grpc, mock, trap, failure;
try {
  const [webPort, grpcPort, mockPort, trapPort] = await Promise.all([port(), port(), port(), port()]);
  mock = await startMockLlm(mockPort);
  trap = http.createServer((req, res) => { receipt.trapRequests++; res.writeHead(503).end("trap"); });
  await new Promise(resolve => trap.listen(trapPort, "127.0.0.1", resolve));
  const cfg = defaultConfig(); cfg.port = webPort; cfg.grpcPort = grpcPort;
  cfg.llm.baseUrl = `http://127.0.0.1:${mockPort}/v1`; cfg.llm.model = "mock";
  cfg.llm.external.enabled = false; cfg.classifier.backend = "llm"; cfg.classifier.laya.enabled = false;
  roots = new Roots({ home, config: cfg }); web = await startServer(roots, createApp(roots)); grpc = await startGrpc(roots);
  for (const protocol of ["http", "grpc"]) for (const failure of [false, true]) {
    const project = `example-pydanticai-${process.pid}-${protocol}-${failure ? "failure" : "clean"}`;
    // Isolate all provider/exporter configuration; poison only the ambient OpenAI base under test.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTEL_|OPENAI_|ANTHROPIC_|REAL_LLM$|MODEL$|NEATLOGS_|NEATROOTS_|MOCK_LLM_URL$)/.test(k)));
    Object.assign(env, { UV_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", PYDANTICAI_PROJECT: project,
      OPENAI_BASE_URL: `http://127.0.0.1:${trapPort}/v1`, OPENAI_API_KEY: "ambient-must-not-be-used",
      MOCK_LLM_URL: cfg.llm.baseUrl, NEATLOGS_ENDPOINT: `http://127.0.0.1:${webPort}`,
      NEATROOTS_GRPC: `127.0.0.1:${grpcPort}`, OTLP_PROTOCOL: protocol, MODEL: failure ? "mock-sloppy" : "mock" });
    if (protocol === "grpc") env.REAL_LLM = "0"; // HTTP covers unset; neither may inherit the trap.
    const child = await run(["run", "--frozen", "agent.py", `Please refund order ${failure ? "4512" : "1001"}`], env);
    assert.equal(child.code, 0, child.output);
    let detail;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const runs = roots.store.listRuns({ project });
      if (runs.length === 1) {
        const row = runs[0], coverage = await checkCoverage(roots, row.trace_id);
        if (row.root_ended && roots.engine.live.get(row.trace_id)?.endHandled && modelChecksComplete(coverage)) {
          detail = { row, coverage, spans: roots.store.getSpans(row.trace_id, false), findings: roots.store.findingsForTrace(row.trace_id) }; break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!detail) receipt.incomplete = roots.store.listRuns({ project }).map(row => ({ row,
      spans: roots.store.getSpans(row.trace_id, false), findings: roots.store.findingsForTrace(row.trace_id),
      summary: roots.store.getSummary(row.trace_id), progress: roots.engine.progress.state(row.trace_id) }));
    assert.ok(detail, "No completed run/check receipt within 20 seconds");
    const { row, spans, findings, coverage } = detail;
    assert.equal(coverage.model.available, true);
    assert.equal(coverage.failed, 0);
    const root = spans.filter(s => !s.parent_span_id); assert.equal(root.length, 1);
    assert.equal(root[0].span_kind, "AGENT");
    const llms = spans.filter(s => s.span_kind === "LLM"), tools = spans.filter(s => s.span_kind === "TOOL");
    assert.equal(llms.length, 2); assert.equal(tools.length, 1);
    assert.equal(spans.length, 4);
    for (const s of spans.filter(s => s.parent_span_id)) assert.equal(s.parent_span_id, root[0].span_id);
    for (const s of llms) { assert.equal(s.model, failure ? "mock-sloppy" : "mock"); assert.ok(s.input_preview); assert.ok(s.output_preview); }
    assert.ok(tools[0].input_preview?.includes(failure ? "4512" : "1001")); assert.ok(tools[0].output_preview);
    const soft = findings.filter(f => f.check_id === "soft-tool-failure");
    if (failure) { assert.equal(soft.length, 1); assert.ok(soft[0].evidence_span_ids.includes(tools[0].span_id)); assert.match(tools[0].output_preview, /404/); }
    else assert.equal(findings.length, 0, "Clean fixture must not produce findings");
    receipt.scenarios.push({ protocol, failure, row, coverage, spans, findings,
      raw: spans.map(s => roots.store.getOtlpSpan(row.trace_id, s.span_id)) });
  }
  assert.equal(receipt.trapRequests, 0, "Ambient hosted base was contacted in mock mode");
  receipt.passed = true;
  console.log("4 PydanticAI HTTP/gRPC clean/failure scenarios passed; no ambient provider requests");
} catch (error) {
  failure = error;
  receipt.passed = false;
  receipt.error = String(error);
} finally {
  try {
    if (grpc) grpc.forceShutdown();
    roots?.close();
    for (const server of [web, mock, trap]) if (server) await close(server);
    fs.rmSync(home, { recursive: true, force: true });
    receipt.cleanedUp = true;
  } catch (error) {
    failure ??= error; receipt.passed = false; receipt.cleanupError = String(error);
  }
  if (artifact) fs.writeFileSync(artifact, JSON.stringify(receipt, null, 2));
}
// Do not inherit long-lived library handles in this standalone CLI after all
// assertions and bounded owned-server teardown have succeeded.
if (failure) console.error(failure);
process.exit(failure ? 1 : 0);
