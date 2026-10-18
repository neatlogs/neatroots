import { afterEach, describe, expect, it } from "vitest";
import { latestMessages, loadTrace, runGoal } from "../src/engine/trace.js";
import { toChat } from "../src/replay/replay.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { batch, hex, makeRoots, mockLlm, s, span, type TestRoots } from "./helpers.js";

// OpenAI's newer models take the system prompt as a "developer" message, and the SDKs record the
// role as sent. Everywhere neatroots looks for a system prompt it must find this one too.

let t: TestRoots | undefined;
let llm: Awaited<ReturnType<typeof mockLlm>> | undefined;
afterEach(async () => {
  await t?.close();
  await llm?.close();
  t = undefined;
  llm = undefined;
});

/** One run whose LLM call opens with a developer message, then a user turn. */
function seedDeveloperRun(tr: TestRoots) {
  const traceId = hex(16);
  const root = span({ traceId, name: "support", kind: "workflow" });
  const llmSpan = span({
    traceId,
    parent: root.spanId,
    name: "openai.chat.completions.create",
    kind: "llm",
    attrs: [
      s("neatlogs.llm.model_name", "mock"),
      s("neatlogs.llm.input_messages.0.role", "developer"),
      s("neatlogs.llm.input_messages.0.content", "Never refund without looking up the order."),
      s("neatlogs.llm.input_messages.1.role", "user"),
      s("neatlogs.llm.input_messages.1.content", "Refund order 1001"),
      s("neatlogs.llm.output_messages.0.role", "assistant"),
      s("neatlogs.llm.output_messages.0.content", "I looked the order up. It was delivered."),
    ],
  });
  tr.roots.ingest([batch([root, llmSpan], "support-agent")]);
  return { traceId, llmSpan };
}

describe("the developer role", () => {
  it("counts as the system prompt in runGoal and stays out of latestMessages", async () => {
    t = await makeRoots({ noEngine: true });
    const { traceId, llmSpan } = seedDeveloperRun(t);
    const snap = loadTrace(t.roots.store, traceId);
    expect(runGoal(snap).system).toBe("Never refund without looking up the order.");
    const input = snap.spans.find((x) => x.id === llmSpan.spanId)!.input;
    const latest = latestMessages(input, 700)!;
    expect(latest).toContain("Refund order 1001");
    expect(latest).not.toContain("Never refund");
  });

  it("shows up as a system card in the conversation view", async () => {
    t = await makeRoots({ noEngine: true });
    const { traceId } = seedDeveloperRun(t);
    const chat = buildChat(loadTrace(t.roots.store, traceId));
    expect(chat.items.map((i) => i.type)).toEqual(["system", "user", "assistant"]);
    expect(chat.items[0]).toMatchObject({ type: "system", text: "Never refund without looking up the order." });
  });

  it("reads as a system turn in toChat", () => {
    expect(toChat([{ role: "developer", content: "be careful" }, { role: "user", content: "hi" }])).toEqual([
      { role: "system", content: "be careful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("lets a replay replace it with a new system prompt instead of sending both", async () => {
    llm = await mockLlm();
    t = await makeRoots({ llmUrl: llm.url, noEngine: true });
    const { traceId, llmSpan } = seedDeveloperRun(t);
    const r = await t.roots.replays.replayLlm(traceId, llmSpan.spanId, { system: "Refunds are always fine." });
    expect(r).toMatchObject({ state: "succeeded" });
    const sent = llm.requests.at(-1).messages as { role: string; content: string }[];
    expect(sent.filter((m) => m.role === "system")).toEqual([{ role: "system", content: "Refunds are always fine." }]);
    expect(sent.some((m) => m.content.includes("Never refund"))).toBe(false);
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "Refund order 1001" });
  });
});
