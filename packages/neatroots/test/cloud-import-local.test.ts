import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { EXPLORE_TOOLS } from "../src/mcp/explore-tools.js";
import { importSource } from "../src/server/api-explore.js";
import { batch, freePort, hex, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

// A run sent from here to Neatlogs Cloud keeps its trace and span ids there. Importing from Cloud
// (the most recent traces, or one by id from the CLI or a coding agent) used to store Cloud's copy
// over the local run: redacted values, no attributes beyond the public API's, marked imported.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.NEATLOGS_SERVICE_TOKEN;
  for (const c of cleanup.splice(0).reverse()) await c();
});

interface CloudTrace {
  traceId: string;
  spans: { spanId: string; parentSpanId: string | null; name: string; type: string; output: string }[];
}

/** The Neatlogs Cloud public API: list, export and span payloads for `traces`. */
async function cloudApi(traces: CloudTrace[], opts: { exportDelayMs?: number } = {}) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    seen.push(url);
    res.setHeader("content-type", "application/json");
    const ok = (data: unknown) => res.end(JSON.stringify({ success: true, requestId: "r", data }));
    if (url.startsWith("/api/v1/public/traces?")) {
      return ok({ traces: traces.map((t) => ({ traceId: t.traceId, workflowName: "prod-agent", startedAt: "2026-10-09T10:00:00Z" })), page: { hasMore: false, nextCursor: null } });
    }
    const t = traces.find((x) => url.startsWith(`/api/v1/public/traces/${x.traceId}/`));
    if (t && url.includes("/export")) {
      const spans = t.spans.map((sp) => ({ traceId: t.traceId, spanId: sp.spanId, parentSpanId: sp.parentSpanId, spanName: sp.name, spanType: sp.type, startedAt: "2026-10-09T10:00:00Z", endedAt: "2026-10-09T10:00:01Z", durationMs: 1000, status: "OK", model: null, provider: null, promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
      return void setTimeout(() => ok({ schemaVersion: 1, trace: { traceId: t.traceId, workflowName: "prod-agent", startedAt: "2026-10-09T10:00:00Z" }, spans }), opts.exportDelayMs ?? 0);
    }
    const sp = t?.spans.find((x) => url.includes(`/spans/${x.spanId}/payload`));
    if (sp) return ok({ fields: { input: { available: false, value: null }, output: { available: true, value: sp.output }, error: { available: false, value: null } } });
    res.statusCode = 404;
    res.end("{}");
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { base: `http://127.0.0.1:${port}/api/v1/public`, seen };
}

async function roots(base: string): Promise<TestRoots> {
  process.env.NEATLOGS_SERVICE_TOKEN = "nlsa_test_token";
  const tb = await makeRoots({ noEngine: true, config: (c) => (c.cloud.apiBase = base) });
  cleanup.push(tb.close);
  return tb;
}

/** A run captured here by an SDK, as Cloud holds it after a forward: same ids, values redacted. */
function sentRun() {
  const t = hex(16);
  const root = hex(8);
  const tool = toolSpan(t, root, "lookup_order", '{"order_id":"4512"}', '{"owner":"jane.doe@example.com"}');
  const local = [batch([tool, span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("app.version", "1.2.3")] })])];
  const inCloud: CloudTrace = {
    traceId: t,
    spans: [
      { spanId: root, parentSpanId: null, name: "refund", type: "workflow", output: "done" },
      { spanId: tool.spanId, parentSpanId: root, name: "lookup_order", type: "tool", output: '{"owner":"[redacted:email]"}' },
    ],
  };
  return { t, root, toolId: tool.spanId, local, inCloud };
}

function expectUntouched(tb: TestRoots, run: ReturnType<typeof sentRun>) {
  const tool = tb.roots.store.getOtlpSpan(run.t, run.toolId)!;
  expect(JSON.stringify(tool.span.attributes)).toContain("jane.doe@example.com");
  expect(JSON.stringify(tool.span.attributes)).not.toContain("[redacted:email]");
  const root = tb.roots.store.getOtlpSpan(run.t, run.root)!;
  expect(root.span.attributes.find((a) => a.key === "app.version")?.value).toEqual({ stringValue: "1.2.3" });
  expect(importSource(tb.roots, run.t)).toBeNull();
}

it("keeps a local run when the CLI or a coding agent imports the same trace from Cloud", async () => {
  const run = sentRun();
  const cloud = await cloudApi([run.inCloud]);
  const tb = await roots(cloud.base);
  tb.roots.ingest(run.local);
  const job = await tb.roots.imports.start("neatlogs-cloud", { traceIds: run.t }, { limit: 1 }).done;
  expectUntouched(tb, run);
  // The job still points at the run (import_cloud_trace opens it), without importing anything.
  expect(job).toMatchObject({ state: "succeeded", traces: 0, spans: 0, skipped: 1, trace_ids: [run.t] });
  expect(cloud.seen.some((u) => u.includes("/export"))).toBe(false);
});

it("gives a coding agent the local run when it imports a trace sent from here", async () => {
  const run = sentRun();
  const cloud = await cloudApi([run.inCloud]);
  const tb = await roots(cloud.base);
  tb.roots.ingest(run.local);
  const tool = EXPLORE_TOOLS.find((x) => x.name === "import_cloud_trace")!;
  const r = (await tool.run(tb.roots, { trace_id: run.t })) as { imported: boolean; trace_id: string; run: { trace_id: string } | null };
  expect(r).toMatchObject({ imported: false, trace_id: run.t, run: { trace_id: run.t } });
  expectUntouched(tb, run);
});

it("imports the other recent Cloud traces and keeps the ones sent from here", async () => {
  const run = sentRun();
  const other = hex(16);
  const otherSpan = hex(8);
  const cloud = await cloudApi([run.inCloud, { traceId: other, spans: [{ spanId: otherSpan, parentSpanId: null, name: "prod", type: "workflow", output: "ok" }] }]);
  const tb = await roots(cloud.base);
  tb.roots.ingest(run.local);
  const job = await tb.roots.imports.start("neatlogs-cloud", {}, { limit: 10 }).done;
  expectUntouched(tb, run);
  expect(job).toMatchObject({ state: "succeeded", traces: 1, skipped: 1 });
  expect(importSource(tb.roots, other)).toBe("neatlogs-cloud");
});

it("keeps a run that started arriving here while its Cloud copy was downloading", async () => {
  const run = sentRun();
  const cloud = await cloudApi([run.inCloud], { exportDelayMs: 300 });
  const tb = await roots(cloud.base);
  const { done } = tb.roots.imports.start("neatlogs-cloud", { traceIds: run.t }, { limit: 1 });
  for (const end = Date.now() + 3000; !cloud.seen.some((u) => u.includes("/export")) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  tb.roots.ingest(run.local);
  const job = await done;
  expectUntouched(tb, run);
  expect(job).toMatchObject({ state: "succeeded", traces: 0, skipped: 1 });
});

it("refreshes a run that was imported from Cloud before", async () => {
  const t = hex(16);
  const root = hex(8);
  const later = hex(8);
  const trace: CloudTrace = { traceId: t, spans: [{ spanId: root, parentSpanId: null, name: "prod", type: "workflow", output: "ok" }] };
  const cloud = await cloudApi([trace]);
  const tb = await roots(cloud.base);
  expect(await tb.roots.imports.start("neatlogs-cloud", { traceIds: t }, { limit: 1 }).done).toMatchObject({ traces: 1 });
  // Cloud has more of the trace now; importing it again brings in the rest.
  trace.spans.push({ spanId: later, parentSpanId: root, name: "lookup_order", type: "tool", output: "found" });
  expect(await tb.roots.imports.start("neatlogs-cloud", { traceIds: t }, { limit: 1 }).done).toMatchObject({ traces: 1, spans: 2 });
  expect(tb.roots.store.getRun(t)!.span_count).toBe(2);
});
