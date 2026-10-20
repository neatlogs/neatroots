import crypto from "node:crypto";

// Runs the e2e tests read. Sent the way agents send them: OTLP JSON with Neatlogs attributes
// (rich LLM messages and tool calls) and the Neatlogs HTTP trace API.

const hex = (n: number) => crypto.randomBytes(n).toString("hex");
const s = (key: string, v: string | number | boolean) =>
  typeof v === "string" ? { key, value: { stringValue: v } } : typeof v === "boolean" ? { key, value: { boolValue: v } } : { key, value: { intValue: String(v) } };

let clock = BigInt(Date.now() - 60_000) * 1_000_000n;
function span(traceId: string, name: string, kind: string, attrs: ReturnType<typeof s>[], parent = "", ms = 50, error?: string) {
  const start = clock;
  const end = start + BigInt(ms) * 1_000_000n;
  clock = end + 2_000_000n;
  const spanId = hex(8);
  return {
    spanId,
    body: {
      traceId,
      spanId,
      parentSpanId: parent,
      name,
      kind: 1,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(end),
      attributes: [s("neatlogs.span.kind", kind), ...attrs],
      status: error ? { code: 2, message: error } : { code: 1 },
    },
  };
}

function llmAttrs(msgs: { role: string; content: string }[], out: string, calls: { name: string; args: string }[] = []) {
  const a = [s("neatlogs.llm.model_name", "gpt-4o-mini"), s("neatlogs.llm.token_count.prompt", 60), s("neatlogs.llm.token_count.completion", 20)];
  msgs.forEach((m, i) => a.push(s(`neatlogs.llm.input_messages.${i}.role`, m.role), s(`neatlogs.llm.input_messages.${i}.content`, m.content)));
  if (out) a.push(s("neatlogs.llm.output_messages.0.role", "assistant"), s("neatlogs.llm.output_messages.0.content", out));
  calls.forEach((c, i) => a.push(s(`neatlogs.llm.tool_calls.${i}.name`, c.name), s(`neatlogs.llm.tool_calls.${i}.arguments`, c.args)));
  return a;
}

async function otlp(url: string, service: string, spans: ReturnType<typeof span>[]) {
  const res = await fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [s("service.name", service)] }, scopeSpans: [{ scope: { name: "e2e" }, spans: spans.map((x) => x.body) }] }] }),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
}

async function http(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/v1/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { trace_id: string };
  return j.trace_id;
}

/** A support run: user asks, model calls a tool, tool answers, model leaks a key (a rule catches it). */
function supportRun(question: string, session: string) {
  const t = hex(16);
  const system = { role: "system", content: "You are a support agent. Never share secrets." };
  const user = { role: "user", content: question };
  const root = span(t, "support", "workflow", [s("neatlogs.session.id", session), s("neatlogs.workflow.input", question)]);
  const l1 = span(t, "openai.chat.completions.create", "llm", llmAttrs([system, user], "", [{ name: "lookup_order", args: '{"order_id":"1001"}' }]), root.spanId, 300);
  const tool = span(t, "lookup_order", "tool", [s("neatlogs.tool.name", "lookup_order"), s("neatlogs.tool.input", '{"order_id":"1001"}'), s("neatlogs.tool.output", '{"status":"delivered"}')], root.spanId, 40);
  const answer = "Order 1001 was delivered. Our payments key is sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c.";
  const l2 = span(t, "openai.chat.completions.create", "llm", llmAttrs([system, user], answer), root.spanId, 400);
  root.body.attributes.push(s("neatlogs.workflow.output", answer));
  return { traceId: t, spans: [root, l1, tool, l2] };
}

export async function seed(url: string) {
  const a = supportRun("Is order 1001 ok?", "e2e-session");
  await otlp(url, "e2e-support", a.spans);
  const b = supportRun("And when will it arrive?", "e2e-session");
  await otlp(url, "e2e-support", b.spans);

  const research = await http(url, {
    name: "orchestrator",
    project: "e2e-research",
    kind: "AGENT",
    input: "Write a note on solar batteries",
    output: "Solar batteries store daytime energy for the night.",
    children: [
      { name: "researcher", kind: "AGENT", input: "solar batteries", output: "Facts about solar batteries", children: [
        { name: "web_search", kind: "TOOL", tool_name: "web_search", input: { q: "solar batteries" }, output: [{ title: "Overview" }], duration_ms: 80 },
        { name: "summarise", kind: "LLM", model: "gpt-4o-mini", input: [{ role: "user", content: "Summarise the search results" }], output: "Facts about solar batteries", duration_ms: 300 },
      ] },
      { name: "writer", kind: "AGENT", input: "Facts about solar batteries", output: "Solar batteries store daytime energy for the night.", children: [
        { name: "write", kind: "LLM", model: "gpt-4o-mini", input: [{ role: "user", content: "Write a short note" }], output: "Solar batteries store daytime energy for the night.", duration_ms: 350 },
      ] },
    ],
  });

  const failed = await http(url, {
    name: "billing",
    project: "e2e-billing",
    input: "Refund invoice 77",
    status: "ERROR",
    error: "payment gateway timeout",
    children: [{ name: "refund", kind: "TOOL", tool_name: "issue_refund", input: { invoice: 77 }, status: "ERROR", error: "payment gateway timeout", duration_ms: 60 }],
  });

  // One retry loop that trips two loop checks (same call repeated, errors in a row): one problem.
  const lookup = { name: "lookup_order", kind: "TOOL", tool_name: "lookup_order", input: { order_id: "4512" }, status: "ERROR", error: "404: order 4512 not found", duration_ms: 30 };
  const loop = await http(url, { name: "refund", project: "e2e-loop", input: "Refund order 4512", output: "I couldn't find order 4512.", children: [lookup, lookup, lookup] });

  // Two spans whose parents point at each other (a buggy exporter): the run must still open.
  const cycle = hex(16);
  const ca = span(cycle, "cycle-agent", "agent", []);
  const cb = span(cycle, "cycle-tool", "tool", [s("neatlogs.tool.name", "cycle-tool")], ca.spanId);
  ca.body.parentSpanId = cb.spanId;
  await otlp(url, "e2e-cycle", [ca, cb]);

  // Let the collector settle before tests read.
  await new Promise((r) => setTimeout(r, 1500));
  return { supportRun: a.traceId, secondTurn: b.traceId, researchRun: research, failedRun: failed, loopRun: loop, cycleRun: cycle };
}
