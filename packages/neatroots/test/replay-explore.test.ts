import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import { EXPLORE_TOOLS } from "../src/mcp/explore-tools.js";
import { toChat } from "../src/replay/replay.js";
import { Replays } from "../src/replay/replay.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { parseSearch } from "../src/server/api-explore.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, s, span, tmpHome, toolSpan, until, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
let llm: Awaited<ReturnType<typeof mockLlm>> | undefined;
afterEach(async () => {
  await t?.close();
  await llm?.close();
  t = undefined;
  llm = undefined;
});

const tool = (name: string) => EXPLORE_TOOLS.find((x) => x.name === name)!;

/** root agent → LLM (asks for lookup) → tool → LLM (answers); plus a sub-agent with its own LLM call. */
function seed(tr: TestRoots, session = "conv-1") {
  const traceId = hex(16);
  const root = span({ traceId, name: "support", kind: "workflow", attrs: [{ key: "neatlogs.session.id", value: { stringValue: session } }] });
  const l1 = llmSpan(traceId, root.spanId, { system: "Be careful.", user: "Is order 1001 ok?", toolCalls: [{ name: "lookup_order", args: '{"id":1001}' }] });
  const t1 = toolSpan(traceId, root.spanId, "lookup_order", '{"id":1001}', '{"status":"delivered"}');
  const l2 = llmSpan(traceId, root.spanId, { system: "Be careful.", user: "Is order 1001 ok?", out: "Order 1001 was delivered." });
  const sub = span({ traceId, parent: root.spanId, name: "billing-agent", kind: "agent" });
  const l3 = llmSpan(traceId, sub.spanId, { user: "Check the refund", out: "No refund due." });
  tr.roots.ingest([batch([root, l1, t1, l2, sub, l3], "support-agent")]);
  return { traceId, root, l1, t1, l2, sub, l3 };
}

describe("run as a chat", () => {
  it("reads user, assistant, tool calls and a sub-agent card in order", async () => {
    t = await makeRoots({ noEngine: true });
    const x = seed(t);
    const chat = buildChat(loadTrace(t.roots.store, x.traceId));
    expect(chat.items.map((i) => i.type)).toEqual(["system", "user", "assistant", "tool", "assistant", "agent"]);
    expect(chat.items[2]).toMatchObject({ type: "assistant", tool_calls: [{ name: "lookup_order" }] });
    expect(chat.items[5]).toMatchObject({ type: "agent", name: "billing-agent", llm_calls: 1 });
    const sub = buildChat(loadTrace(t.roots.store, x.traceId), x.sub.spanId);
    expect(sub.items.map((i) => i.type)).toEqual(["user", "assistant"]);
  });
});

describe("replay", () => {
  it("turns recorded messages into chat turns", () => {
    expect(toChat([{ role: "system", content: "s" }, { role: "assistant", content: "", tool_calls: [{ name: "f", arguments: { a: 1 } }] }, { role: "tool", name: "f", content: "ok" }])).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: '[called f({"a":1})]' },
      { role: "user", content: "[tool result from f]\nok" },
    ]);
  });

  it("forks one LLM call with an edited message and links the new run", async () => {
    llm = await mockLlm();
    t = await makeRoots({ llmUrl: llm.url, noEngine: true });
    const x = seed(t);
    const r = await t.roots.replays.replayLlm(x.traceId, x.l2.spanId, { messages: [{ role: "user", content: "Is order 2002 ok?" }] });
    expect(r).toMatchObject({ state: "succeeded", kind: "llm" });
    expect(llm.requests.at(-1).messages).toEqual([{ role: "user", content: "Is order 2002 ok?" }]);
    expect(t.roots.store.getRun(r.new_trace_id!)).toMatchObject({ project: "support-agent", llm_calls: 1 });
    expect(t.roots.replays.originOf(r.new_trace_id!)?.id).toBe(r.id);
    expect(t.roots.replays.forRun(x.traceId)).toHaveLength(1);
    await expect(t.roots.replays.replayLlm(x.traceId, x.t1.spanId)).rejects.toThrow(/only LLM spans/);
  });

  it("re-runs the agent through its registered command and links the run it sends", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const x = seed(t);
    t.roots.config.rerun["support-agent"] = {
      // A stand-in agent: reads the replay input from the environment and sends a run.
      command: `node -e "fetch(process.env.NEATLOGS_ENDPOINT + '/v1/trace', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name:'support', project:'support-agent', input: process.env.NEATROOTS_REPLAY_INPUT, output: 'model=' + (process.env.NEATROOTS_REPLAY_MODEL||'')})}).then(r=>r.text()).then(console.log)"`,
    };
    const { replay, done } = t.roots.replays.startRun(x.traceId, { input: "Is order 3003 ok?", model: "small-model" });
    expect(replay.state).toBe("running");
    const r = await done;
    expect(r).toMatchObject({ state: "succeeded", via: "command" });
    const run = t.roots.store.getRun(r.new_trace_id!)!;
    expect(run.input_preview).toContain("3003");
    expect(run.output_preview).toContain("model=small-model");
    expect(() => t!.roots.replays.startRun(hex(16))).toThrow(/run not found/);
  }, 30_000);

  it("fails the replay, not the server, when the rerun folder is gone", async () => {
    t = await makeRoots({ noEngine: true });
    const x = seed(t);
    // Registered while the folder existed, then the folder was deleted (a removed worktree, say).
    const gone = path.join(tmpHome(), "deleted-agent-dir");
    t.roots.config.rerun["support-agent"] = { command: "node -e 0", cwd: gone };
    const { done } = t.roots.replays.startRun(x.traceId);
    const r = await done;
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/rerun folder .*deleted-agent-dir doesn't exist/);
    expect(t.roots.replays.get(r.id)?.state).toBe("failed");
  });

  it("refuses to register a rerun command in a folder that doesn't exist", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const post = (cwd: string) =>
      fetch(`${t!.url}/api/projects/support-agent/rerun`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "node agent.js", cwd }) });
    const bad = await post(path.join(tmpHome(), "missing"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/no such folder/);
    expect(t.roots.config.rerun["support-agent"]).toBeUndefined();
    const dir = tmpHome();
    expect((await post(dir)).status).toBe(200);
    expect(t.roots.config.rerun["support-agent"]).toMatchObject({ command: "node agent.js", cwd: dir });
  });

  it("marks replays left running as failed on restart", async () => {
    t = await makeRoots({ noEngine: true });
    const id = `rp_${hex(6)}`;
    // A replay that was in-flight when the process stopped.
    t.roots.store.db
      .prepare(
        `INSERT INTO replays (id, trace_id, span_id, kind, via, overrides, state, new_trace_id, output_preview, error, log_tail, created_ms, finished_ms)
         VALUES (?, ?, null, 'run', 'command', '{}', 'running', null, null, null, null, ?, null)`,
      )
      .run(id, hex(16), Date.now());
    // Simulate a restart: a fresh Replays runs its startup cleanup on the same DB.
    new Replays(t.roots);
    const r = t.roots.replays.get(id)!;
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/interrupted by a restart/);
    expect(r.finished_ms).not.toBeNull();
  });
});

describe("search and exploring tools", () => {
  it("parses filters and free text", () => {
    expect(parseSearch('project:support status:failed "order 1001" tool:lookup refund')).toEqual({ text: "order 1001 refund", filters: { project: "support", status: "failed", tool: "lookup" } });
  });

  it("status: takes the words people use (failed, succeeded) for what runs store", async () => {
    t = await makeRoots({ noEngine: true, serve: true });
    const ok = seed(t, "conv-ok");
    const bad = hex(16);
    t.roots.ingest([batch([span({ traceId: bad, name: "billing", kind: "workflow", status: 2, message: "gateway timeout" })], "billing-agent")]);
    await until(() => t!.roots.store.getRun(bad)?.status === "error");
    const ids = async (q: string) => ((await (await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`)).json()) as { runs: { trace_id: string }[] }).runs.map((r) => r.trace_id);
    expect(await ids("status:failed")).toEqual([bad]);
    expect(await ids("status:error")).toEqual([bad]);
    expect(await ids("status:succeeded")).toEqual([ok.traceId]);
  });

  it("answers context, in-run search, conversation, compare and read-only SQL", async () => {
    t = await makeRoots({ noEngine: true });
    const a = seed(t, "conv-9");
    const b = seed(t, "conv-9");
    const ctx = (await tool("get_span_context").run(t.roots, { trace_id: a.traceId, span_id: a.t1.spanId.slice(0, 8) })) as { ancestors: unknown[]; position: string; previous_sibling: { kind: string } };
    expect(ctx.ancestors).toHaveLength(1);
    expect(ctx.previous_sibling.kind).toBe("LLM");
    const found = (await tool("search_in_run").run(t.roots, { trace_id: a.traceId, query: "DELIVERED" })) as { matches: number };
    expect(found.matches).toBeGreaterThan(0);
    const conv = (await tool("get_conversation").run(t.roots, { trace_id: b.traceId })) as { turns: unknown[] };
    expect(conv.turns).toHaveLength(2);
    const cmp = (await tool("compare_runs").run(t.roots, { a: a.traceId, b: b.traceId })) as { same_tool_sequence: boolean };
    expect(cmp.same_tool_sequence).toBe(true);
    const sql = (await tool("query_sql").run(t.roots, { sql: "SELECT project, COUNT(*) AS n FROM runs GROUP BY project" })) as { rows: { project: string; n: number }[] };
    expect(sql.rows).toEqual([{ project: "support-agent", n: 2 }]);
    await expect(tool("query_sql").run(t.roots, { sql: "DELETE FROM runs" })).rejects.toThrow(/only a single SELECT/);
    await expect(tool("query_sql").run(t.roots, { sql: "SELECT 1; DELETE FROM runs" })).rejects.toThrow(/only a single SELECT/);
    const nav: string[] = [];
    t.roots.bus.on("navigate", (e) => nav.push(e.path));
    await tool("show_in_ui").run(t.roots, { trace_id: a.traceId, view: "timeline" });
    await until(() => nav.length > 0);
    expect(nav[0]).toBe(`runs/${a.traceId}?view=timeline`);
  });

  it("list_projects counts failed runs, including ones interrupted by a restart", async () => {
    t = await makeRoots({ noEngine: true });
    const ok = hex(16);
    const bad = hex(16);
    const cut = hex(16);
    t.roots.ingest([
      batch([span({ traceId: ok, name: "checkout", kind: "workflow" })], "shop-agent"),
      batch([span({ traceId: bad, name: "checkout", kind: "workflow", status: 2, message: "gateway timeout" })], "shop-agent"),
      batch([span({ traceId: cut, name: "checkout", kind: "workflow", attrs: [s("neatlogs.trace.interrupted", true)] })], "shop-agent"),
      batch([span({ traceId: hex(16), name: "browse", kind: "workflow" })], "calm-agent"),
    ]);
    const projects = (await tool("list_projects").run(t.roots, {})) as { project: string; runs: number; failed: number }[];
    const shop = projects.find((p) => p.project === "shop-agent")!;
    expect(shop.runs).toBe(3);
    // Runs store ok/error/interrupted; a failed count of 0 for a project with an error and an
    // interrupted run is the bug.
    expect(shop.failed).toBe(2);
    expect(projects.find((p) => p.project === "calm-agent")!.failed).toBe(0);
  });

  it("stops a SQL query at the row cap instead of running it to the end", async () => {
    t = await makeRoots({ noEngine: true });
    type Out = { rows: { n: number }[]; truncated: boolean };
    const exact = (await tool("query_sql").run(t.roots, { sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c LIMIT 200) SELECT n FROM c" })) as Out;
    expect(exact.truncated).toBe(false);
    expect(exact.rows).toHaveLength(200);
    // Unbounded, and row 202 raises a SQLite error: this only comes back if the tool stops reading early.
    const sql = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT CASE WHEN n <= 201 THEN n ELSE json(n || 'x') END AS n FROM c";
    const capped = (await tool("query_sql").run(t.roots, { sql })) as Out;
    expect(capped.truncated).toBe(true);
    expect(capped.rows.map((r) => r.n)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
});
