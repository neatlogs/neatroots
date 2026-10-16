import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { finalOutput, loadTrace, runGoal } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { decodeTraceJson } from "../src/otlp/codec.js";
import type { KeyValue, OtlpSpan, Plain } from "../src/otlp/types.js";
import { buildView } from "../src/semantics/view.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { chainValue, finalReply, langChainMessage, pythonLiteral, reprFields, toolInput, toolOutput } from "../src/semantics/langchain.js";
import { batch, hex, llmSpan, makeRoots, mockLlm, s, span, tmpHome, until } from "./helpers.js";

// LangGraph / LangChain runs (#251): the instrumentations store LangChain's serialized messages
// as the tool result and as the run's answer. A ToolMessage's tool_call_id changes on every call,
// so no two results ever compared equal, and the root output is the whole graph state, so the
// run's answer was never empty and always "admitted" the failed tool's error message. The same
// scenarios fire the four checks for the OpenAI Agents SDK and Pydantic AI; they must for
// LangGraph too, whichever of the three tracing setups sent the run.

const homes: string[] = [];
const stores: Store[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  // Closed before the directory goes: Windows won't delete a database that is still open.
  for (const st of stores.splice(0)) st.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function store(): Store {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  stores.push(st);
  return st;
}

const lib = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks as RuleCheck[];
const rule = (id: string) => lib.find((c) => c.id === id)!;
const fires = (st: Store, t: string, id: string, atEnd = false) => evaluateRule(rule(id), loadTrace(st, t), atEnd)?.firing === true;

// --- the three ways a LangGraph run reaches neatroots -----------------------------------------

type Sender = "openinference" | "openllmetry" | "neatlogs-handler";
const SENDERS: Sender[] = ["openinference", "openllmetry", "neatlogs-handler"];

interface Call {
  tool: string;
  args: Record<string, Plain>;
  result?: string;
  error?: string;
  id: string;
}
interface Scenario {
  question: string;
  calls: Call[];
  /** The last AI message's content; undefined when the graph stopped without one. */
  answer: string | undefined;
}

/** Python's repr of a string, as pydantic prints fields and LangChain prints input_str. */
function py(v: Plain): string {
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(new RegExp(q, "g"), "\\" + q) + q;
  }
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(py).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${py(k)}: ${py(x)}`).join(", ")}}`;
}

/** message_to_dict, as OpenInference and the Neatlogs SDK's instrumentations=["langchain"] write it. */
const OI = {
  msg: (type: string, content: Plain, extra: Record<string, Plain> = {}): Plain => ({ type, data: { content, additional_kwargs: {}, response_metadata: {}, type, name: null, id: null, ...extra } }),
  human: (content: string) => OI.msg("human", content),
  ai: (content: string, calls: Plain[] = []) => OI.msg("ai", content, { tool_calls: calls, invalid_tool_calls: [], usage_metadata: null }),
  tool: (content: string, name: string, id: string, status = "success") => OI.msg("tool", content, { name, tool_call_id: id, artifact: null, status }),
};
/** dumpd / to_json, as OpenLLMetry's JSON encoder writes Serializable objects. */
const LC = {
  msg: (cls: string, kwargs: Record<string, Plain>): Plain => ({ lc: 1, type: "constructor", id: ["langchain", "schema", "messages", cls], kwargs }),
  human: (content: string) => LC.msg("HumanMessage", { content, type: "human" }),
  ai: (content: string, calls: Plain[] = []) => LC.msg("AIMessage", { content, type: "ai", tool_calls: calls, invalid_tool_calls: [] }),
  tool: (content: string, name: string, id: string, status = "success") => LC.msg("ToolMessage", { content, type: "tool", name, tool_call_id: id, status }),
};
/** str(message): pydantic's repr of the fields, as the Neatlogs SDK's callback handler writes tool outputs and (through json.dumps default=str) chain outputs. */
const REPR = {
  human: (content: string) => `content=${py(content)} additional_kwargs={} response_metadata={}`,
  ai: (content: string, calls: Plain[] = []) => `content=${py(content)} additional_kwargs={} response_metadata={} tool_calls=${py(calls)} invalid_tool_calls=[]`,
  tool: (content: string, name: string, id: string, _status?: string) => `content=${py(content)} name=${py(name)} tool_call_id=${py(id)}`,
};

const toolCall = (c: Call): Plain => ({ name: c.tool, args: c.args, id: c.id, type: "tool_call" });
const resultOf = (c: Call) => c.result ?? `Error: RuntimeError(${py(c.error ?? "failed")})\n Please fix your mistakes.`;

/** The graph's final state, as each sender serializes it. */
function state(sender: Sender, sc: Scenario): Plain[] {
  const M = sender === "openinference" ? OI : sender === "openllmetry" ? LC : REPR;
  const out: Plain[] = [M.human(sc.question)];
  for (const c of sc.calls) out.push(M.ai("", [toolCall(c)]), M.tool(resultOf(c), c.tool, c.id, c.error ? "error" : "success"));
  if (sc.answer !== undefined) out.push(M.ai(sc.answer));
  return out;
}

/** A span without the test helper's neatlogs.span.kind, as a plain OpenTelemetry exporter sends it. */
function raw(p: Omit<Parameters<typeof span>[0], "kind">): OtlpSpan {
  const sp = span({ ...p, kind: "x" });
  sp.attributes = sp.attributes.filter((a) => a.key !== "neatlogs.span.kind");
  return sp;
}

/** The scenario's spans as one sender would export them: the tool calls, the LLM's last reply, then the graph's root span. */
function spansOf(sender: Sender, t: string, root: string, sc: Scenario): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  sc.calls.forEach((c, i) => {
    const status = c.error ? 2 : 1;
    if (sender === "openinference") {
      const attrs: KeyValue[] = [s("openinference.span.kind", "TOOL"), s("tool.name", c.tool), s("input.value", JSON.stringify(c.args))];
      if (c.result !== undefined) attrs.push(s("output.value", JSON.stringify(OI.tool(c.result, c.tool, c.id))));
      spans.push(raw({ traceId: t, parent: root, name: c.tool, attrs, status, message: c.error }));
    } else if (sender === "openllmetry") {
      const metadata = { langgraph_step: 2 + i * 2, langgraph_node: "tools", langgraph_triggers: ["branch:to:tools"], langgraph_path: ["__pregel_pull", "tools"], langgraph_checkpoint_ns: `tools:${hex(8)}`, checkpoint_ns: `tools:${hex(8)}` };
      const input = JSON.stringify({ input_str: py(c.args), tags: ["seq:step:1"], metadata, inputs: c.args, kwargs: { color: "green", name: c.tool } });
      const attrs: KeyValue[] = [s("traceloop.span.kind", "tool"), s("traceloop.entity.name", c.tool), s("traceloop.entity.input", input), s("gen_ai.tool.call.arguments", input)];
      if (c.result !== undefined) {
        const output = JSON.stringify({ output: LC.tool(c.result, c.tool, c.id), kwargs: { color: "green", name: c.tool } });
        attrs.push(s("traceloop.entity.output", output), s("gen_ai.tool.call.result", output));
      }
      spans.push(raw({ traceId: t, parent: root, name: `${c.tool}.tool`, attrs, status, message: c.error }));
    } else {
      const attrs: KeyValue[] = [s("neatlogs.tool.name", c.tool), s("input.value", py(c.args))];
      if (c.result !== undefined) attrs.push(s("output.value", REPR.tool(c.result, c.tool, c.id)));
      spans.push(span({ traceId: t, parent: root, name: `langchain.tool.${c.tool}`, kind: "tool", attrs, status, message: c.error }));
    }
  });
  const reply = sc.answer ?? "";
  if (sender === "openinference") spans.push(raw({ traceId: t, parent: root, name: "ChatOpenAI", attrs: [s("openinference.span.kind", "LLM"), s("llm.model_name", "gpt-4.1"), s("llm.output_messages.0.message.role", "assistant"), s("llm.output_messages.0.message.content", reply)] }));
  else if (sender === "openllmetry") spans.push(raw({ traceId: t, parent: root, name: "ChatOpenAI.chat", attrs: [s("gen_ai.request.model", "gpt-4.1"), s("llm.request.type", "chat"), s("gen_ai.completion.0.role", "assistant"), s("gen_ai.completion.0.content", reply)] }));
  else spans.push(llmSpan(t, root, { user: sc.question, out: reply }));
  const input = { messages: [["user", sc.question]] };
  const messages = state(sender, sc);
  if (sender === "openinference") spans.push(raw({ traceId: t, spanId: root, name: "LangGraph", attrs: [s("openinference.span.kind", "CHAIN"), s("input.value", JSON.stringify(input)), s("output.value", JSON.stringify({ messages }))] }));
  else if (sender === "openllmetry")
    spans.push(
      raw({
        traceId: t,
        spanId: root,
        name: "LangGraph.workflow",
        attrs: [
          s("traceloop.span.kind", "workflow"),
          s("traceloop.entity.name", "LangGraph"),
          s("traceloop.entity.input", JSON.stringify({ inputs: input, tags: [], metadata: {}, kwargs: { name: "LangGraph" } })),
          s("traceloop.entity.output", JSON.stringify({ outputs: { messages }, kwargs: { tags: [], run_id: hex(8) } })),
        ],
      }),
    );
  else spans.push(span({ traceId: t, spanId: root, name: "langchain.chain.LangGraph", kind: "chain", attrs: [s("input.value", JSON.stringify(input)), s("output.value", JSON.stringify({ messages }))] }));
  return spans;
}

function ingest(st: Store, sender: Sender, sc: Scenario): string {
  const t = hex(16);
  st.ingest([batch(spansOf(sender, t, hex(8), sc), `langgraph-${sender}`)]);
  return t;
}

const weather = (n: number, result: (i: number) => string = () => "Sunny in Lagos"): Call[] => Array.from({ length: n }, (_, i) => ({ tool: "get_weather", args: { city: "Lagos" }, result: result(i), id: `call_${i + 1}` }));
const LOOP: Scenario = { question: "weather in Lagos?", calls: weather(4), answer: "It is sunny in Lagos." };
const PAGINATION: Scenario = { question: "weather in Lagos?", calls: weather(4, (i) => `Forecast page ${i + 1}: sunny`), answer: "It is sunny in Lagos." };
const CYCLE: Scenario = {
  question: "weather and time in Lagos?",
  calls: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? { tool: "get_weather", args: { city: "Lagos", try: i }, result: "Sunny in Lagos", id: `call_${i + 1}` } : { tool: "get_time", args: { city: "Lagos", try: i }, result: "12:00", id: `call_${i + 1}` })),
  answer: "It is sunny in Lagos at noon.",
};
const CYCLE_PROGRESS: Scenario = { ...CYCLE, calls: CYCLE.calls.map((c, i) => ({ ...c, result: `${c.result} (${i})` })) };
const FAILED: Scenario = { question: "weather in Lagos?", calls: [{ tool: "get_weather", args: { city: "Lagos" }, error: "weather service unavailable", id: "call_1" }], answer: "It is sunny in Lagos." };
const FAILED_HONEST: Scenario = { ...FAILED, answer: "I couldn't reach the weather service, so I can't tell you the forecast." };
const EMPTY: Scenario = { question: "weather in Lagos?", calls: weather(1), answer: "" };
const STOPPED_ON_TOOL: Scenario = { question: "weather in Lagos?", calls: weather(1), answer: undefined };

describe.each(SENDERS)("LangGraph runs traced with %s", (sender) => {
  it("repeated-tool-call fires on the same call and result four times, whatever the tool_call_id", () => {
    const st = store();
    const hit = evaluateRule(rule("repeated-tool-call"), loadTrace(st, ingest(st, sender, LOOP)), false);
    expect(hit?.firing).toBe(true);
    expect(hit?.params).toMatchObject({ tool: "get_weather", count: "4", result: "Sunny in Lagos" });
    expect(hit?.params.args).toBe('{"city":"Lagos"}');
  });

  it("repeated-tool-call stays quiet when the result inside the envelope changes", () => {
    const st = store();
    expect(fires(st, ingest(st, sender, PAGINATION), "repeated-tool-call")).toBe(false);
  });

  it("tool-cycle fires on two tools going around with the same results", () => {
    const st = store();
    const hit = evaluateRule(rule("tool-cycle"), loadTrace(st, ingest(st, sender, CYCLE)), false);
    expect(hit?.firing).toBe(true);
    expect(hit?.params.pattern).toBe("get_weather -> get_time");
  });

  it("tool-cycle stays quiet when every result is new", () => {
    const st = store();
    expect(fires(st, ingest(st, sender, CYCLE_PROGRESS), "tool-cycle")).toBe(false);
  });

  it("unrecovered-tool-failure fires when the tool failed and the last AI message claims success", () => {
    const st = store();
    const t = ingest(st, sender, FAILED);
    expect(finalOutput(loadTrace(st, t))).toBe("It is sunny in Lagos.");
    const hit = evaluateRule(rule("unrecovered-tool-failure"), loadTrace(st, t), true);
    expect(hit?.firing).toBe(true);
    expect(hit?.params.tool).toBe("get_weather");
    expect(hit?.params.error).toContain("weather service unavailable");
  });

  it("unrecovered-tool-failure stays quiet when the last AI message admits the failure", () => {
    const st = store();
    expect(fires(st, ingest(st, sender, FAILED_HONEST), "unrecovered-tool-failure", true)).toBe(false);
  });

  it("empty-final-answer fires when the last AI message is empty, and when the graph stopped on a tool result", () => {
    const st = store();
    for (const sc of [EMPTY, STOPPED_ON_TOOL]) {
      const t = ingest(st, sender, sc);
      expect(finalOutput(loadTrace(st, t))).toBeUndefined();
      expect(fires(st, t, "empty-final-answer", true)).toBe(true);
    }
  });

  it("empty-final-answer stays quiet when the graph answered", () => {
    const st = store();
    expect(fires(st, ingest(st, sender, LOOP), "empty-final-answer", true)).toBe(false);
  });

  it("the run is previewed by its question and its answer, not the serialized state", () => {
    const st = store();
    const t = ingest(st, sender, LOOP);
    const run = st.getRun(t)!;
    expect(run.input_preview).toBe("weather in Lagos?");
    expect(run.output_preview).toBe("It is sunny in Lagos.");
    expect(runGoal(loadTrace(st, t)).rootInput).toBe("weather in Lagos?");
  });

  it("the conversation shows the tool's result and arguments, not the envelope", () => {
    const st = store();
    const chat = buildChat(loadTrace(st, ingest(st, sender, LOOP)));
    const tools = chat.items.filter((i) => i.type === "tool");
    expect(tools).toHaveLength(4);
    for (const item of tools) {
      expect(item.type === "tool" && item.output).toBe("Sunny in Lagos");
      expect(item.type === "tool" && item.input).toEqual({ city: "Lagos" });
    }
  });
});

describe("the traces from #251, as recorded from a real LangGraph run with OpenInference", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/langgraph-openinference.json", import.meta.url), "utf8")) as unknown;
  const TRACES = { loop: "9c7caec3ce824d1d8a44695b69fd9ca8", loopPlain: "854bb0dc3d6e4dee9e6c2874d624f57e", failed: "9e0b6d9d876c4248b8c41f58763b447d", failedPlain: "5de3cd9236e841faa0bda1eb4427cb23" };

  it("the envelope and the plain form now raise the same findings", () => {
    const st = store();
    st.ingest(decodeTraceJson(fixture));
    const table = Object.fromEntries(
      Object.entries(TRACES).map(([name, t]) => [name, ["repeated-tool-call", "tool-cycle", "unrecovered-tool-failure", "empty-final-answer"].filter((id) => fires(st, t, id, true))]),
    );
    expect(table).toEqual({ loop: ["repeated-tool-call"], loopPlain: ["repeated-tool-call"], failed: ["unrecovered-tool-failure"], failedPlain: ["unrecovered-tool-failure"] });
  });

  it("reads the answer out of the graph state, including a message serialized as a JSON string", () => {
    const st = store();
    st.ingest(decodeTraceJson(fixture));
    expect(finalOutput(loadTrace(st, TRACES.failed))).toBe("It is sunny in Lagos.");
    expect(st.getRun(TRACES.failed)!.output_preview).toBe("It is sunny in Lagos.");
    expect(st.getRun(TRACES.loop)!.input_preview).toBe("weather in Lagos?");
  });

  it("raises them live, through the engine", async () => {
    const llm = await mockLlm({});
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.push(async () => {
      await tb.close();
      await llm.close();
    });
    tb.roots.ingest(decodeTraceJson(fixture));
    const loop = await until(() => tb.roots.store.findingsForTrace(TRACES.loop).find((f) => f.check_id === "repeated-tool-call"), 15000);
    expect(loop.status).toBe("raised");
    const failed = await until(() => tb.roots.store.findingsForTrace(TRACES.failed).find((f) => f.check_id === "unrecovered-tool-failure"), 15000);
    expect(failed.status).toBe("raised");
    await tb.roots.engine!.waitIdle(TRACES.failed, 10000);
    expect(tb.roots.store.findingsForTrace(TRACES.failed).map((f) => f.check_id)).not.toContain("empty-final-answer");
  });
});

describe("labeled smoke: 180 generated LangGraph runs, no misses and no false alarms", () => {
  it("repeated-tool-call across the three senders", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 180; i++) {
      const sender = SENDERS[i % 3];
      const kind = Math.floor(i / 3) % 4;
      const n = 3 + (i % 3);
      const args = { q: `item-${i}` };
      const call = (k: number, result: string, extra: Partial<Call> = {}): Call => ({ tool: "search", args, result, id: `call_${i}_${k}`, ...extra });
      let calls: Call[];
      let expectFire: boolean;
      if (kind === 0) { calls = Array.from({ length: n }, (_, k) => call(k, `{"hits": ${i}}`)); expectFire = true; }
      else if (kind === 1) { calls = Array.from({ length: n }, (_, k) => call(k, `{"hits": ${i}, "page": ${k}}`)); expectFire = false; }
      else if (kind === 2) { calls = Array.from({ length: n }, (_, k) => call(k, "Error: HTTP 503\n Please fix your mistakes.")); expectFire = true; }
      else { calls = Array.from({ length: n }, (_, k) => call(k, `{"hits": ${i}}`, { args: { q: `item-${i}-${k}` } })); expectFire = false; }
      const st = store();
      const fired = fires(st, ingest(st, sender, { question: "find it", calls, answer: "done" }), "repeated-tool-call");
      if (expectFire && fired) tp++; else if (expectFire) fn++; else if (fired) fp++; else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 90, fn: 0, fp: 0, tn: 90 });
  });
});

describe("reading LangChain's serialized messages", () => {
  it("reads message_to_dict, dumpd, model_dump and str() into the same message", () => {
    const dumped = { content: "Sunny in Lagos", additional_kwargs: {}, response_metadata: {}, type: "tool", name: "get_weather", id: null, tool_call_id: "call_1", artifact: null, status: "success" };
    const want = { role: "tool", content: "Sunny in Lagos", name: "get_weather", tool_call_id: "call_1" };
    expect(langChainMessage(OI.tool("Sunny in Lagos", "get_weather", "call_1"))).toEqual({ ...want, status: "success" });
    expect(langChainMessage(LC.tool("Sunny in Lagos", "get_weather", "call_1"))).toEqual({ ...want, status: "success" });
    expect(langChainMessage(dumped)).toEqual({ ...want, status: "success" });
    expect(langChainMessage(REPR.tool("Sunny in Lagos", "get_weather", "call_1"))).toEqual(want);
    expect(langChainMessage(JSON.stringify(OI.tool("Sunny in Lagos", "get_weather", "call_1")))).toEqual({ ...want, status: "success" });
  });

  it("keeps an AI message's tool calls and reads message chunks and chat messages", () => {
    const calls = [{ name: "get_weather", args: { city: "Lagos" }, id: "call_1", type: "tool_call" }];
    const want = { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "get_weather", arguments: { city: "Lagos" } }] };
    expect(langChainMessage(OI.ai("", calls))).toEqual(want);
    expect(langChainMessage(LC.ai("", calls))).toEqual(want);
    expect(langChainMessage(REPR.ai("", calls))).toEqual(want);
    expect(langChainMessage({ lc: 1, type: "constructor", id: ["langchain", "schema", "messages", "AIMessageChunk"], kwargs: { content: "Hi", type: "AIMessageChunk" } })).toEqual({ role: "assistant", content: "Hi" });
    expect(langChainMessage({ type: "chat", data: { content: "Hi", type: "chat", role: "critic" } })).toEqual({ role: "critic", content: "Hi" });
    expect(langChainMessage(REPR.human("weather in Lagos?"))).toEqual({ role: "user", content: "weather in Lagos?" });
  });

  it("leaves values that merely look alike alone", () => {
    expect(langChainMessage({ type: "user", data: { id: 7 } })).toBeUndefined();
    expect(langChainMessage({ type: "tool", content: "x" })).toBeUndefined();
    expect(langChainMessage({ lc: 1, type: "constructor", id: ["langchain", "prompts", "ChatPromptTemplate"], kwargs: { content: "x" } })).toBeUndefined();
    expect(langChainMessage("content=Sunny in Lagos")).toBeUndefined();
    expect(langChainMessage("contents of the file")).toBeUndefined();
    const sensor = { type: "sensor", data: { content: "x", type: "sensor" } };
    expect(toolOutput(sensor)).toEqual(sensor);
    expect(toolOutput(["a", "b"])).toEqual(["a", "b"]);
    expect(chainValue(["a", "b"])).toEqual(["a", "b"]);
    expect(chainValue({ output: "x", kwargs: {}, extra: 1 })).toEqual({ output: "x", kwargs: {}, extra: 1 });
    expect(toolInput({ input_str: "x", other: 1 })).toEqual({ input_str: "x", other: 1 });
  });

  it("unwraps OpenLLMetry's envelopes and drops LangGraph's per-step metadata", () => {
    expect(toolInput({ input_str: "{'city': 'Lagos'}", tags: ["seq:step:1"], metadata: { langgraph_step: 4 }, inputs: { city: "Lagos" }, kwargs: { color: "green" } })).toEqual({ city: "Lagos" });
    expect(toolInput({ input_str: "{'city': 'Lagos'}", tags: [], metadata: { langgraph_step: 4 }, inputs: null, kwargs: {} })).toEqual({ city: "Lagos" });
    expect(toolInput("{'city': \"O'Hare\"}")).toEqual({ city: "O'Hare" });
    expect(toolOutput({ output: LC.tool("Sunny", "get_weather", "call_9"), kwargs: { name: "get_weather" } })).toBe("Sunny");
    expect(toolOutput({ output: { temp: 31 }, kwargs: {} })).toEqual({ temp: 31 });
    expect(chainValue({ inputs: { messages: [["user", "hi"]] }, tags: [], metadata: {}, kwargs: { name: "LangGraph" } })).toEqual([{ role: "user", content: "hi" }]);
    expect(chainValue({ outputs: { messages: [LC.human("hi"), LC.ai("hello")] }, kwargs: {} })).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    expect(chainValue({ outputs: LC.ai("hello"), kwargs: {} })).toEqual({ role: "assistant", content: "hello" });
  });

  it("reads a graph state with other keys, JSON-string members and content blocks", () => {
    const stateValue = { messages: [OI.human("hi"), JSON.stringify(OI.tool("x", "t", "c1")), { type: "ai", data: { content: [{ type: "text", text: "It is sunny." }, { type: "tool_use", id: "t1", name: "get_weather", input: {} }], type: "ai" } }], remaining_steps: 3 };
    const msgs = chainValue(stateValue) as Record<string, Plain>[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(finalReply(msgs)).toBe("It is sunny.");
    expect(finalReply([{ role: "user", content: "hi" }, { role: "tool", content: "x" }])).toBe("");
    expect(finalReply({ role: "assistant", content: "ok" })).toBe("ok");
    expect(finalReply("plain")).toBeUndefined();
    expect(finalReply({ answer: "x" })).toBeUndefined();
  });

  it("parses Python literals as pydantic and LangChain print them", () => {
    expect(pythonLiteral("{'a': [1, 2.5, -3], 'b': None, 'c': (True, False), 'd': {'e': \"it's\"}}")).toEqual({ a: [1, 2.5, -3], b: null, c: [true, false], d: { e: "it's" } });
    expect(pythonLiteral("'line\\none \\'quoted\\' \\\\ \\x41\\u00e9\\U0001F600'")).toBe("line\none 'quoted' \\ Aé😀");
    expect(pythonLiteral("datetime.datetime(2026, 1, 1)")).toBeUndefined();
    expect(pythonLiteral("{1, 2}")).toBeUndefined();
    expect(pythonLiteral("'unterminated")).toBeUndefined();
    expect(reprFields("content='It\\'s sunny' name='w' tool_call_id='c1'")).toEqual({ content: "It's sunny", name: "w", tool_call_id: "c1" });
    expect(reprFields("content=\"say 'hi' name='x'\" tool_call_id='c1'")).toEqual({ content: "say 'hi' name='x'", tool_call_id: "c1" });
    expect(reprFields("content='Sunny' name='w' tool_call_id='c1' trailing")).toBeUndefined();
    expect(reprFields("content='Sunny'  name='w'")).toBeUndefined();
    expect(reprFields("content=[{'type': 'text', 'text': 'hi'}] additional_kwargs={} response_metadata={}")).toEqual({ content: [{ type: "text", text: "hi" }], additional_kwargs: {}, response_metadata: {} });
  });

  it("a tool output clipped by the sender mid-envelope is left as text", () => {
    const clipped = REPR.tool("x".repeat(50), "get_weather", "call_1").slice(0, 40);
    expect(toolOutput(clipped)).toBe(clipped);
  });

  it("the view reads a LangChain tool span the same with any of the three attribute sets", () => {
    const t = hex(16);
    const want = { kind: "TOOL", toolName: "get_weather", input: { city: "Lagos" }, output: "Sunny in Lagos" };
    const oi = raw({ traceId: t, name: "get_weather", attrs: [s("openinference.span.kind", "TOOL"), s("tool.name", "get_weather"), s("input.value", '{"city": "Lagos"}'), s("output.value", JSON.stringify(OI.tool("Sunny in Lagos", "get_weather", "call_1")))] });
    expect(buildView(oi, [])).toMatchObject(want);
    const tl = raw({
      traceId: t,
      name: "get_weather.tool",
      attrs: [
        s("traceloop.span.kind", "tool"),
        s("traceloop.entity.name", "get_weather"),
        s("traceloop.entity.input", JSON.stringify({ input_str: "{'city': 'Lagos'}", tags: [], metadata: { langgraph_step: 2 }, inputs: { city: "Lagos" }, kwargs: {} })),
        s("traceloop.entity.output", JSON.stringify({ output: LC.tool("Sunny in Lagos", "get_weather", "call_1"), kwargs: {} })),
      ],
    });
    expect(buildView(tl, [])).toMatchObject(want);
    const nl = span({ traceId: t, name: "langchain.tool.get_weather", kind: "tool", attrs: [s("neatlogs.tool.name", "get_weather"), s("input.value", "{'city': 'Lagos'}"), s("output.value", REPR.tool("Sunny in Lagos", "get_weather", "call_1"))] });
    expect(buildView(nl, [])).toMatchObject(want);
  });
});
