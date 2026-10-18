import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { currentRequest } from "../src/store/db.js";
import { batch, hex, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const msgAttrs = (prefix: string, msgs: { role: string; content?: string }[]) =>
  msgs.flatMap((m, i) => [s(`neatlogs.llm.${prefix}.${i}.role`, m.role), ...(m.content !== undefined ? [s(`neatlogs.llm.${prefix}.${i}.content`, m.content)] : [])]);

describe("a later turn of a chat session", () => {
  const history = [
    { role: "system", content: "You are a friendly travel assistant." },
    { role: "user", content: "Hi! I'm planning a trip to Lisbon." },
    { role: "assistant", content: "Lovely, when are you going?" },
    { role: "user", content: "What should I pack for October?" },
    { role: "assistant", content: "Layers and a light rain jacket." },
    { role: "user", content: "And one restaurant you'd recommend?" },
  ];

  it("is titled by the current request, not the history before it", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    const input = JSON.stringify({ history: history.slice(0, 5), text: "And one restaurant you'd recommend?" });
    t.roots.ingest([batch([span({ traceId: tid, spanId: root, name: "chat-turn", kind: "workflow", attrs: [s("neatlogs.workflow.input", input)] })])]);
    expect(t.roots.store.getRun(tid)!.input_preview).toBe("And one restaurant you'd recommend?");
    expect(currentRequest(history as never)).toBe("And one restaurant you'd recommend?");
  });

  it("shows the earlier turns as paired user and assistant history, then the current request", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([
      batch([
        span({ traceId: tid, parent: root, name: "openai.chat.completions.create", kind: "llm", attrs: [s("neatlogs.llm.model_name", "mock"), ...msgAttrs("input_messages", history), ...msgAttrs("output_messages", [{ role: "assistant", content: "Try Taberna da Rua das Flores." }])] }),
        span({ traceId: tid, spanId: root, name: "chat-turn", kind: "workflow" }),
      ]),
    ]);
    const items = buildChat(loadTrace(t.roots.store, tid)).items.map((i) => [i.type, "history" in i && i.history ? "earlier" : "now", "text" in i ? i.text : ""]);
    expect(items).toEqual([
      ["system", "now", "You are a friendly travel assistant."],
      ["user", "earlier", "Hi! I'm planning a trip to Lisbon."],
      ["assistant", "earlier", "Lovely, when are you going?"],
      ["user", "earlier", "What should I pack for October?"],
      ["assistant", "earlier", "Layers and a light rain jacket."],
      ["user", "now", "And one restaurant you'd recommend?"],
      ["assistant", "now", "Try Taberna da Rua das Flores."],
    ]);
  });
});

describe("an agent step whose tool call the SDK didn't record", () => {
  it("reads the call from the tool span that ran next", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([
      batch([
        span({ traceId: tid, parent: root, name: "openai.chat.completions.create", kind: "llm", attrs: [s("neatlogs.llm.model_name", "mock"), ...msgAttrs("input_messages", [{ role: "user", content: "I want a refund for order 1001" }]), ...msgAttrs("output_messages", [{ role: "assistant" }])] }),
        toolSpan(tid, root, "issue_refund", '{"order_id":"1001"}', '{"refunded":1.0}'),
        span({ traceId: tid, spanId: root, name: "Refunds agent", kind: "agent" }),
      ]),
    ]);
    const assistant = buildChat(loadTrace(t.roots.store, tid)).items.find((i) => i.type === "assistant");
    expect(assistant).toMatchObject({ inferred: true, tool_calls: [{ name: "issue_refund" }] });
  });
});

describe("a run whose root span is the LLM call", () => {
  it.each(["", "0123456789abcdef"])("uses the child conversation without duplicating its wrapper reply with parent %j", async (parent) => {
    t = await makeRoots({ serve: true, noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    const child = hex(8);
    const attrs = [
      s("neatlogs.llm.model_name", "mock"),
      ...msgAttrs("input_messages", [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }]),
      ...msgAttrs("output_messages", [{ role: "assistant", content: "Hello back." }]),
    ];
    t.roots.ingest([batch([
      span({ traceId: tid, spanId: root, parent, name: "llm-wrapper", kind: "llm", attrs }),
      span({ traceId: tid, spanId: child, parent: root, name: "llm-child", kind: "llm", attrs }),
    ])]);
    for (const selection of ["", `?agent=${root}`, `?agent=${child}`]) {
      const response = await fetch(`${t.url}/api/runs/${tid}/chat${selection}`);
      expect(response.status).toBe(200);
      const chat = await response.json();
      expect(chat.items).toMatchObject([
        { type: "system", text: "Be concise.", span_id: child },
        { type: "user", text: "Hello", span_id: child },
        { type: "assistant", text: "Hello back.", span_id: child },
      ]);
      expect(chat.items).toHaveLength(3);
    }
  });

  it("keeps the root conversation when the only child LLM belongs to a nested agent", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    const agent = hex(8);
    t.roots.ingest([batch([
      span({ traceId: tid, spanId: root, name: "root-llm", kind: "llm", attrs: [
        ...msgAttrs("input_messages", [{ role: "user", content: "Root request" }]),
        ...msgAttrs("output_messages", [{ role: "assistant", content: "Root reply" }]),
      ] }),
      span({ traceId: tid, spanId: agent, parent: root, name: "nested-agent", kind: "agent" }),
      span({ traceId: tid, parent: agent, name: "nested-llm", kind: "llm", attrs: [
        ...msgAttrs("output_messages", [{ role: "assistant", content: "Nested reply" }]),
      ] }),
    ])]);
    expect(buildChat(loadTrace(t.roots.store, tid)).items).toMatchObject([
      { type: "user", text: "Root request", span_id: root },
      { type: "assistant", text: "Root reply", span_id: root },
      { type: "agent", span_id: agent },
    ]);
  });

  it.each(["", "0123456789abcdef"])("keeps message roles and tool calls with parent %j", async (parent) => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([batch([span({ traceId: tid, spanId: root, parent, name: "openai.chat.completions.create", kind: "llm", attrs: [
      s("neatlogs.llm.model_name", "mock"),
      ...msgAttrs("input_messages", [{ role: "system", content: "Be concise." }, { role: "user", content: "Look up order 1001" }]),
      ...msgAttrs("output_messages", [{ role: "assistant" }]),
      s("neatlogs.llm.tool_calls.0.name", "lookup_order"),
      s("neatlogs.llm.tool_calls.0.arguments", '{"order_id":"1001"}'),
    ] })])]);
    const snapshot = loadTrace(t.roots.store, tid);
    const chat = buildChat(snapshot);
    expect(buildChat(snapshot, root)).toEqual(chat);
    expect(chat.root).toBe(root);
    expect(chat.items).toHaveLength(3);
    expect(chat.items).toMatchObject([
      { type: "system", text: "Be concise.", span_id: root },
      { type: "user", text: "Look up order 1001", span_id: root },
      { type: "assistant", text: "", span_id: root, model: "mock", tool_calls: [{ name: "lookup_order", arguments: { order_id: "1001" } }] },
    ]);
  });
});

describe("an LLM root with a recorded tool result", () => {
  it("keeps the root request and reply before its tool result", async () => {
    t = await makeRoots({ serve: true, noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([batch([
      span({ traceId: tid, spanId: root, name: "root-llm", kind: "llm", attrs: [
        s("neatlogs.llm.model_name", "mock"),
        ...msgAttrs("input_messages", [{ role: "user", content: "Find my order" }]),
        ...msgAttrs("output_messages", [{ role: "assistant", content: "Checking it now." }]),
      ] }),
      toolSpan(tid, root, "lookup_order", '{"id":1001}', '{"status":"delivered"}'),
    ])]);
    const response = await fetch(`${t.url}/api/runs/${tid}/chat`);
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items).toHaveLength(3);
    expect(items).toMatchObject([
      { type: "user", text: "Find my order", span_id: root },
      { type: "assistant", text: "Checking it now.", span_id: root },
      { type: "tool", name: "lookup_order", output: { status: "delivered" } },
    ]);
  });
});
