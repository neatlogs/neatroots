import { afterEach, describe, expect, it } from "vitest";
import { loadTrace, runGoal } from "../src/engine/trace.js";
import { plainToAny, type KeyValue } from "../src/otlp/types.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { buildView } from "../src/semantics/view.js";
import { batch, hex, makeRoots, mockLlm, s, span, type TestRoots } from "./helpers.js";

// The OpenTelemetry GenAI conventions record the system prompt in gen_ai.system_instructions,
// apart from gen_ai.input.messages (Pydantic AI does by default). Everywhere neatroots looks for a
// system prompt it must find this one too.

let t: TestRoots | undefined;
let llm: Awaited<ReturnType<typeof mockLlm>> | undefined;
afterEach(async () => {
  await t?.close();
  await llm?.close();
  t = undefined;
  llm = undefined;
});

const SYSTEM = "Never refund without calling lookup_order first.";
const instructions = (parts: unknown[]) => s("gen_ai.system_instructions", JSON.stringify(parts));
const userTurn = s("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Refund order 1001" }] }]));

/** The view of a GenAI chat span with these attributes and no neatlogs.span.kind. */
function genaiView(attrs: KeyValue[]) {
  const sp = span({ traceId: hex(16), name: "chat", kind: "", attrs: [s("gen_ai.operation.name", "chat"), ...attrs] });
  return buildView({ ...sp, attributes: sp.attributes.filter((a) => a.key !== "neatlogs.span.kind") }, []);
}

/** One run whose LLM call records its system prompt in gen_ai.system_instructions. */
function seedRun(tr: TestRoots) {
  const traceId = hex(16);
  const root = span({ traceId, name: "invoke_agent refund", kind: "agent" });
  const llmSpan = span({
    traceId,
    parent: root.spanId,
    name: "chat mock",
    kind: "llm",
    attrs: [
      s("gen_ai.request.model", "mock"),
      instructions([{ type: "text", content: SYSTEM }]),
      userTurn,
      s("gen_ai.output.messages", JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "Refunded." }], finish_reason: "stop" }])),
    ],
  });
  tr.roots.ingest([batch([root, llmSpan], "refund-agent")]);
  return { traceId, llmSpan };
}

describe("gen_ai.system_instructions", () => {
  it("puts the system prompt first in the LLM input, from a JSON string or a structured value", () => {
    const expected = [
      { role: "system", content: SYSTEM },
      { role: "user", content: "Refund order 1001" },
    ];
    expect(genaiView([instructions([{ type: "text", content: SYSTEM }]), userTurn]).input).toEqual(expected);
    expect(genaiView([{ key: "gen_ai.system_instructions", value: plainToAny([{ type: "text", content: SYSTEM }]) }, userTurn]).input).toEqual(expected);
  });

  it("keeps a span's plain input as the user turn", () => {
    expect(genaiView([s("input.value", "Refund order 1001"), instructions([{ type: "text", content: SYSTEM }])]).input).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "Refund order 1001" },
    ]);
  });

  it("reads only text parts", () => {
    const parts = [
      { type: "text", content: "Be brief." },
      { type: "blob", modality: "image", mime_type: "image/png", content: "iVBORw0KGgo=" },
      { type: "reasoning", content: "thinking out loud" },
      { type: "text", content: SYSTEM },
    ];
    expect(genaiView([instructions(parts), userTurn]).input).toEqual([
      { role: "system", content: `Be brief.\n${SYSTEM}` },
      { role: "user", content: "Refund order 1001" },
    ]);
  });

  it("doesn't add a second system prompt when the messages carry one", () => {
    const messages = s("gen_ai.input.messages", JSON.stringify([{ role: "system", parts: [{ type: "text", content: "Original." }] }, { role: "user", parts: [{ type: "text", content: "Q?" }] }]));
    expect(genaiView([messages, instructions([{ type: "text", content: SYSTEM }])]).input).toEqual([
      { role: "system", content: "Original." },
      { role: "user", content: "Q?" },
    ]);
  });

  it("is the run's system prompt in runGoal, the conversation and search", async () => {
    t = await makeRoots({ noEngine: true });
    const { traceId } = seedRun(t);
    const snap = loadTrace(t.roots.store, traceId);
    expect(runGoal(snap)).toMatchObject({ system: SYSTEM, user: "Refund order 1001" });
    expect(buildChat(snap).items.map((i) => i.type)).toEqual(["system", "user", "assistant"]);
    expect(t.roots.store.searchSpans("lookup_order", 10).map((h) => h.trace_id)).toContain(traceId);
  });

  it("is sent again when the LLM call is replayed", async () => {
    llm = await mockLlm();
    t = await makeRoots({ llmUrl: llm.url, noEngine: true });
    const { traceId, llmSpan } = seedRun(t);
    expect(await t.roots.replays.replayLlm(traceId, llmSpan.spanId)).toMatchObject({ state: "succeeded" });
    const sent = llm.requests.at(-1).messages as { role: string; content: string }[];
    expect(sent).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "Refund order 1001" },
    ]);
  });
});
