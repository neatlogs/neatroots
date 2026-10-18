import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { inspectRun, loopback, verifyRun } from "../toolchain/verify-run.mjs";
const trace = "a".repeat(32), check = "openharness-smoke";
function data() { return { run: { trace_id: trace, root_span_id: "root", status: "ok", complete: 1 },
  spans: [{ trace_id: trace, span_id: "root", span_kind: "WORKFLOW" },
    { trace_id: trace, span_id: "LLM", parent_span_id: "root", span_kind: "LLM" },
    { trace_id: trace, span_id: "TOOL", parent_span_id: "root", span_kind: "TOOL" }],
  findings: [{ id: "finding", trace_id: trace, check_id: check, check_kind: "rule", status: "raised", evidence_span_ids: ["TOOL"] }],
  coverage: { state: "rules-only", pending: 0 } }; }
test("exact trace, semantic spans and real rule evidence are required", () => {
  assert.equal(inspectRun(data(), trace, check).coverage, "rules-only");
  for (const mutate of [
    d => d.findings = [], d => d.findings[0].evidence_span_ids = ["missing"],
    d => d.run.trace_id = "other", d => d.run.complete = 0,
    d => d.coverage.state = "checking", d => d.coverage.pending = 1,
    d => d.spans[2].parent_span_id = "orphan", d => d.findings[0].check_kind = "question",
  ]) { const d = data(); mutate(d); assert.equal(inspectRun(d, trace, check), null); }
});
test("refuses remote URL, URL credentials and extra path", () => {
  for (const url of ["https://example.com", "http://user:pass@localhost", "http://localhost/private", "http://localhost?secret=x"]) assert.throws(() => loopback(url));
});
test("HTTP verification only requests the explicit trace and suppresses response contents", async t => {
  const paths = []; const server = http.createServer((req, res) => { paths.push(req.url); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data())); });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const result = await verifyRun("http://127.0.0.1:" + server.address().port, trace, check);
  assert.equal(result.finding_id, "finding"); assert.deepEqual(paths, ["/api/runs/" + trace]);
});
test("stalled local response and redirects fail within bounded deadline", async t => {
  const server = http.createServer((_req, _res) => {});
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(verifyRun("http://127.0.0.1:" + server.address().port, trace, check, 100));
});
