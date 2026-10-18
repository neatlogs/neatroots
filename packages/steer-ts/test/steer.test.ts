import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { applyAnthropic, applyMessages, NeatrootsHalt, rootsMiddleware, checkMyWork, configure, handleToolCall, replayInput, wrapAnthropic, wrapOpenAI, type Note } from "../src/index.js";

const notes: (Note | null)[] = [];
const claims: any[] = [];
let mode = "advisory";
/** Milliseconds to hold the next claim replies (a busy neatroots). */
const slow: number[] = [];
let server: http.Server;
let url = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      let out: unknown = {};
      if (req.url === "/api/steer/claim") {
        claims.push(b);
        out = { mode, note: notes.shift() ?? null };
      } else if (req.url === "/api/steer/check") out = { probability: 0.2, answer: "no", evidence_span_ids: ["s1"] };
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      }, req.url === "/api/steer/claim" ? (slow.shift() ?? 0) : 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  configure({ url, traceId: () => "a".repeat(32) });
  notes.length = 0;
  claims.length = 0;
  mode = "advisory";
  slow.length = 0;
});

const note = (text = "Stop retrying.", kind: Note["kind"] = "template"): Note => ({ id: "n1", kind, text, finding_id: "f1" });

describe("neatroots-steer (ts)", () => {
  it("adds the note to OpenAI-style messages", async () => {
    notes.push(note());
    const out = await applyMessages([{ role: "user", content: "hi" }]);
    expect(out[0].content).toContain("<neatroots-guidance>");
    expect(claims[0].trace_id).toBe("a".repeat(32));
    const after = await applyMessages([{ role: "tool", content: "{}" }], note());
    expect(after).toHaveLength(2);
    expect(after[1].role).toBe("user");
  });

  it("joins the Anthropic tool_result turn", async () => {
    const out = await applyAnthropic([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }], note());
    expect((out[0].content as any[]).at(-1).text).toContain("Stop retrying.");
  });

  it("wraps an OpenAI client", async () => {
    notes.push(note());
    let seen: any;
    const client = wrapOpenAI({ chat: { completions: { create: async (p: any) => ((seen = p), "ok") } } });
    expect(await client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "q" }] })).toBe("ok");
    expect(seen.messages[0].content).toContain("<neatroots-guidance>");
  });

  it("wraps the client a withOptions copy returns", async () => {
    notes.push(note("Your rule says stop.", "halt"), note("Your rule says stop.", "halt"));
    const makeOpenAI = (): any => ({ chat: { completions: { create: async (_p: unknown) => "should not run" } }, withOptions: () => makeOpenAI() });
    await expect(wrapOpenAI(makeOpenAI()).withOptions().chat.completions.create({ messages: [{ role: "user", content: "q" }] })).rejects.toBeInstanceOf(NeatrootsHalt);
    const makeAnthropic = (): any => ({ messages: { create: async (_p: unknown) => "should not run" }, withOptions: () => makeAnthropic() });
    await expect(wrapAnthropic(makeAnthropic()).withOptions().messages.create({ messages: [] })).rejects.toBeInstanceOf(NeatrootsHalt);
  });

  it("applies a replay's input, model and system prompt", async () => {
    expect(replayInput("original")).toBe("original");
    process.env.NEATROOTS_REPLAY_INPUT = "edited";
    process.env.NEATROOTS_REPLAY_MODEL = "small-model";
    process.env.NEATROOTS_REPLAY_SYSTEM_PROMPT = "Be brief.";
    try {
      expect(replayInput("original")).toBe("edited");
      let seen: any;
      const client = wrapOpenAI({ chat: { completions: { create: async (p: unknown) => (seen = p) } } });
      await client.chat.completions.create({ model: "big", messages: [{ role: "user", content: "hi" }] });
      expect(seen.model).toBe("small-model");
      expect(seen.messages[0]).toEqual({ role: "system", content: "Be brief." });
    } finally {
      delete process.env.NEATROOTS_REPLAY_INPUT;
      delete process.env.NEATROOTS_REPLAY_MODEL;
      delete process.env.NEATROOTS_REPLAY_SYSTEM_PROMPT;
    }
  });

  it("raises NeatrootsHalt for halt notes", async () => {
    notes.push(note("Your rule says stop.", "halt"));
    const client = wrapOpenAI({ chat: { completions: { create: async (_p: unknown) => "should not run" } } });
    await expect(client.chat.completions.create({ messages: [{ role: "user", content: "q" }] })).rejects.toBeInstanceOf(NeatrootsHalt);
  });

  it("ignores a note, a halt included, that arrives with steering off", async () => {
    mode = "off";
    notes.push(note("Your rule says stop.", "halt"));
    const client = wrapOpenAI({ chat: { completions: { create: async (_p: unknown) => "ran" } } });
    await expect(client.chat.completions.create({ messages: [{ role: "user", content: "q" }] })).resolves.toBe("ran");
  });

  it("works as AI SDK 7 middleware", async () => {
    notes.push(note("Check the order id first."));
    let prompt: any;
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doGenerate: async (opts: any) => {
          prompt = opts.prompt;
          return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] } as any;
        },
      }),
      middleware: rootsMiddleware(),
    });
    const r = await generateText({ model, prompt: "refund 4512" });
    expect(r.text).toBe("done");
    expect(JSON.stringify(prompt)).toContain("Check the order id first.");
  });

  it("asks neatroots about the run and answers tool calls", async () => {
    expect((await checkMyWork("Did I verify?")).probability_yes).toBe(0.2);
    expect(JSON.parse((await handleToolCall("check_my_work", '{"question":"Q?"}'))!).answer).toBe("no");
    expect(await handleToolCall("other", "{}")).toBeUndefined();
  });

  it("asks again on the next call after one slow reply, so a halt isn't held back", async () => {
    slow.push(900); // neatroots is busy: this reply takes longer than the hook waits
    expect(await applyMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
    notes.push(note("Stop now.", "halt"));
    // was: every call for the next 5 s skipped neatroots, so the halt never arrived
    await expect(applyMessages([{ role: "user", content: "again" }])).rejects.toBeInstanceOf(NeatrootsHalt);
  });

  it("backs off after a few slow replies in a row, as for a stopped neatroots", async () => {
    slow.push(900, 900, 900);
    for (let i = 0; i < 3; i++) await applyMessages([{ role: "user", content: "hi" }]);
    const sent = claims.length;
    notes.push(note());
    await applyMessages([{ role: "user", content: "hi" }]);
    expect(claims.length).toBe(sent); // skipped: neatroots is treated as stuck for a while
  });

  it("is silent when neatroots is unreachable", async () => {
    configure({ url: "http://127.0.0.1:9", traceId: () => "b".repeat(32) });
    const msgs = [{ role: "user", content: "q" }];
    expect(await applyMessages(msgs)).toBe(msgs);
    expect((await checkMyWork("q")).answer).toBe("unknown");
  });
});
