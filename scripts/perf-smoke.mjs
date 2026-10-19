#!/usr/bin/env node
// Performance smoke test, run nightly (.github/workflows/nightly.yml). It builds a store of about
// 3,000 runs and 36,000 spans with realistic text, then times what has to stay fast as a store grows:
// ingest, text search, the match count, snippets, re-sent spans, deletes, and the search-index
// rebuild after an update.
//
//   pnpm build && node scripts/perf-smoke.mjs
//
// PERF_RUNS sets the store size (default 3000). PERF_BUDGET_FACTOR scales every budget: 0.001 makes
// them all fail, to check that the script can fail. The budgets are about ten times what a CI runner
// needs, and far below what the regressions they guard against cost here: before #462, scanning the
// search index for every ingested span made 1,200 spans take 18 s at half this size. Search that
// reads every match's text only gets slow on stores much larger than this (gigabytes, read from
// disk), so test/search-ids.test.ts checks that at the SQL level instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Number(process.env.PERF_RUNS ?? 3000);
const FACTOR = Number(process.env.PERF_BUDGET_FACTOR ?? 1);
// A NaN budget would pass every check, so a bad value stops the test instead.
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`PERF_RUNS must be a positive whole number, not ${JSON.stringify(process.env.PERF_RUNS)}`);
if (!Number.isFinite(FACTOR) || FACTOR <= 0) throw new Error(`PERF_BUDGET_FACTOR must be a positive number, not ${JSON.stringify(process.env.PERF_BUDGET_FACTOR)}`);

// A home of its own, with Laya off and on a port nothing uses: never a neatroots or Laya on this machine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-perf-"));
fs.writeFileSync(
  path.join(home, "config.yaml"),
  "port: 4997\ngrpcPort: 0\nclassifier:\n  laya:\n    enabled: false\n    port: 4998\nretention:\n  days: 3650\n  maxGb: 100\n",
);
process.env.NEATROOTS_HOME = home;
const { Roots } = await import(pathToFileURL(path.join(root, "packages/neatroots/dist/index.js")).href);

// ------------------------------------------------------------------ data

let seed = 42;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = (list) => list[Math.floor(rand() * list.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const WORDS = "order refund customer shipping Paris invoice timeout account status payment delivery address ticket update lookup request error retry policy warehouse".split(" ");
const RARE = "zanzibar";
const text = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const s = (key, value) => ({ key, value: { stringValue: String(value) } });
let clock = BigInt(Date.now() - 86_400_000) * 1_000_000n;

function span(traceId, parentSpanId, name, kind, attrs, spanId = hex(16)) {
  const start = clock;
  const end = start + 5_000_000n;
  clock = end + 1_000_000n;
  const attributes = [s("neatlogs.span.kind", kind), ...attrs];
  return { traceId, spanId, parentSpanId, name, kind: 1, startTimeUnixNano: String(start), endTimeUnixNano: String(end), attributes, events: [], links: [], status: { code: 1 } };
}

const tool = (traceId, parent, rare, spanId) => {
  const name = pick(["lookup_order", "issue_refund", "search_docs"]);
  const output = rare ? `${text(100)} ${RARE} ${text(100)}` : text(200);
  return span(traceId, parent, name, "tool", [s("neatlogs.tool.name", name), s("neatlogs.tool.input", JSON.stringify({ q: text(8) })), s("neatlogs.tool.output", output)], spanId);
};

/** One run: an agent root, five LLM calls and six tool calls (12 spans, 1–2 KB of text each). */
function run(rare = false) {
  const traceId = hex(32);
  const top = span(traceId, "", "agent", "workflow", [s("neatlogs.workflow.input", text(40)), s("neatlogs.workflow.output", text(60))]);
  const spans = [top];
  for (let i = 0; i < 5; i++) {
    spans.push(
      span(traceId, top.spanId, "openai.chat.completions.create", "llm", [
        s("neatlogs.llm.model_name", "gpt-4.1"),
        s("neatlogs.llm.input_messages.0.role", "user"),
        s("neatlogs.llm.input_messages.0.content", text(250)),
        s("neatlogs.llm.output_messages.0.role", "assistant"),
        s("neatlogs.llm.output_messages.0.content", text(120)),
      ]),
    );
    spans.push(tool(traceId, top.spanId, rare && i === 0));
  }
  spans.push(tool(traceId, top.spanId, false));
  return spans;
}

const batch = (spans) => ({ resource: { attributes: [s("service.name", "perf-agent")] }, scope: { name: "perf", attributes: [] }, spans });

// ------------------------------------------------------------- measuring

const results = [];
function measure(name, budgetMs, fn) {
  const t0 = performance.now();
  const out = fn();
  const info = Array.isArray(out) ? `${out.length} results` : (out ?? "");
  results.push({ name, ms: performance.now() - t0, budget: budgetMs * FACTOR, info });
  return out;
}
// A server's event loop runs its startup work (such as marking a new store's search index current)
// right after it starts; give this process the same turns before using the store.
const settle = () => new Promise((r) => setTimeout(r, 50));
const failures = [];
const expect = (what, ok) => ok || failures.push(what);

// ------------------------------------------------------------------ test

let roots = new Roots({ noEngine: true });
const store = () => roots.store;
await settle();

measure(`build a store of ${RUNS} runs (${RUNS * 12} spans)`, 180_000, () => {
  for (let i = 0; i < RUNS; i += 20) {
    const spans = [];
    for (let j = i; j < Math.min(i + 20, RUNS); j++) spans.push(...run(j % 100 === 0));
    roots.ingest([batch(spans)]);
  }
  return `${store().countRuns()} runs`;
});

const total = store().countRuns();
const common = measure("text search for a common word (100 newest)", 300, () => store().listRuns({ text: "refund", limit: 100 }));
expect(`the common-word search lists ${Math.min(100, RUNS)} runs`, common.length === Math.min(100, RUNS));
const matching = measure("count of runs matching a common word", 300, () => store().countMatchingRuns({ text: "refund" }));
expect(`every run matches the common word (${matching} of ${total})`, matching === total);
const rare = measure("text search for a rare word", 100, () => store().listRuns({ text: RARE, limit: 100 }));
expect(`the rare-word search finds the ${Math.ceil(RUNS / 100)} runs that have it (${rare.length})`, rare.length === Math.ceil(RUNS / 100));
measure("text search with a tool filter", 300, () => store().listRuns({ text: "refund", tool: "issue_refund", limit: 100 }));
const page = common.slice(0, 50).map((r) => r.trace_id);
measure("snippets for a page of 50 runs", 200, () => store().searchSpans("refund", 1000, page));

measure("ingest 100 new runs, one run per request (1,200 spans)", 3000, () => {
  for (let i = 0; i < 100; i++) roots.ingest([batch(run())]);
});
measure("re-send 500 stored spans with new text", 3000, () => {
  const stored = store().db.prepare("SELECT trace_id AS t, span_id AS s, parent_span_id AS p FROM spans WHERE tool_name IS NOT NULL ORDER BY seq LIMIT 500").all();
  for (const r of stored) roots.ingest([batch([tool(r.t, r.p ?? "", false, r.s)])]);
});
measure("delete the 100 oldest runs", 2000, () => {
  const oldest = store().db.prepare("SELECT trace_id FROM runs ORDER BY received_ms LIMIT 100").all().map((r) => r.trace_id);
  store().deleteRuns(oldest);
});

// The first start after an update fills in the search index's run ids in the background
// (span_fts_ids, from 0.2.9 on; a build without them fails here instead of crashing).
const hasIds = !!store().db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'span_fts_ids'").get();
expect("the store has span_fts_ids", hasIds);
if (hasIds) {
  expect("the store's search index is marked current, as a server leaves it", store().db.prepare("SELECT value FROM meta WHERE key = 'search_index'").get()?.value === "2");
  const before = store().countMatchingRuns({ text: "refund" });
  store().db.exec("DROP TABLE span_fts_ids");
  roots.close();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const t0 = performance.now();
  roots = new Roots({ noEngine: true });
  const indexed = () => store().db.prepare("SELECT (SELECT COUNT(*) FROM span_fts_docsize) = (SELECT COUNT(*) FROM span_fts_ids) AS done").get().done === 1;
  while (!indexed() && performance.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 25));
  loop.disable();
  results.push({ name: "fill in the search index's run ids (first start after an update)", ms: performance.now() - t0, budget: 60_000 * FACTOR, info: "" });
  results.push({ name: "longest event-loop stall while filling them in", ms: loop.max / 1e6, budget: 300 * FACTOR, info: "" });
  expect("the run ids are filled in", indexed());
  expect("search gives the same count after the rebuild", store().countMatchingRuns({ text: "refund" }) === before);
}
roots.close();
fs.rmSync(home, { recursive: true, force: true });

// ---------------------------------------------------------------- report

const over = results.filter((r) => r.ms > r.budget);
const rows = results.map((r) => `| ${r.ms > r.budget ? "✗" : "✓"} | ${r.name} | ${r.ms.toFixed(1)} ms | ${r.budget.toFixed(1)} ms | ${r.info} |`);
const report = ["| | Operation | Took | Budget | |", "| --- | --- | --- | --- | --- |", ...rows, ...failures.map((f) => `| ✗ | ${f} | | | |`)].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Performance smoke test\n\n${report}\n`);
if (over.length || failures.length) {
  console.error(`\n${over.length} over budget, ${failures.length} wrong result(s).`);
  process.exit(1);
}
