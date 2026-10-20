import http from "node:http";
import crypto from "node:crypto";

// A predictable stand-in LLM for examples, demos and tests, so they run without API keys.
// Speaks OpenAI chat completions (with streaming and tool calls) and Anthropic messages.
//
// Behaviour: with tools offered and a new user turn, it calls the tool whose name best matches
// the request, with arguments pulled from the text (numbers, quoted words). After a tool result it
// answers from that result. A model name containing "sloppy" reproduces common agent mistakes:
// it claims success even when the tool failed, so neatroots' checks have something to find.

interface Msg {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface Tool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, { type?: string }>; required?: string[] };
}

const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : ((p as { text?: string; content?: unknown }).text ?? text((p as { content?: unknown }).content)))).join("\n") : c == null ? "" : JSON.stringify(c);

function pickTool(tools: Tool[], ask: string): Tool {
  const words = new Set(ask.toLowerCase().match(/[a-z]+/g) ?? []);
  let best = tools[0];
  let score = -1;
  for (const t of tools) {
    const parts = `${t.name} ${t.description ?? ""}`.toLowerCase().match(/[a-z]+/g) ?? [];
    const s = parts.filter((p) => p.length > 2 && words.has(p)).length;
    if (s > score) [best, score] = [t, s];
  }
  return best;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function argsFor(tool: Tool, ask: string): Record<string, unknown> {
  const props = tool.parameters?.properties ?? {};
  const line = firstLine(ask);
  const numbers = line.match(/\d+(?:\.\d+)?/g) ?? [];
  const quoted = line.match(/"([^"]+)"|'([^']+)'/)?.slice(1).find(Boolean);
  // "weather in Paris" → Paris; otherwise the last capitalised word that doesn't start the sentence.
  const place = /\b(?:in|at|for|to)\s+([A-Z][\w-]+(?:\s[A-Z][\w-]+)?)/.exec(line)?.[1] ?? line.split(/\s+/).slice(1).reverse().find((w) => /^[A-Z][a-z]/.test(w))?.replace(/[^\w-]/g, "");
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, p] of Object.entries(props)) {
    if (p.type === "number" || p.type === "integer") out[k] = numbers[n] !== undefined ? Number(numbers[n++]) : 1;
    else if (/id$|_id|number/i.test(k) && numbers[n] !== undefined) out[k] = numbers[n++];
    else if (p.type === "boolean") out[k] = true;
    else if (/city|location|place|country|destination/i.test(k) && place) out[k] = place;
    else out[k] = quoted ?? line.replace(/[?.!]+$/, "").slice(0, 80);
  }
  return out;
}

/** The name of the tool a tool-result message answers, from the assistant turn that called it. */
function toolNameFor(messages: Msg[], m: Msg): string | undefined {
  for (const a of messages) for (const c of a.tool_calls ?? []) if (c.id === m.tool_call_id) return c.function.name;
  return undefined;
}

/** What the mock says next, given the conversation and the tools on offer. */
export function mockReply(messages: Msg[], tools: Tool[], model: string): { content: string; toolCall?: { name: string; args: Record<string, unknown> } } {
  const sloppy = /sloppy/i.test(model);
  const last = messages[messages.length - 1];
  const userAsk = text([...messages].reverse().find((m) => m.role === "user")?.content);
  const toolTurns = messages.filter((m) => m.role === "tool");
  // A result from a tool this call doesn't offer (an agent handoff) starts a fresh turn.
  const foreign = last?.role === "tool" && tools.length > 0 && !!toolNameFor(messages, last) && !tools.some((t) => t.name === toolNameFor(messages, last));
  if (last && (last.role !== "tool" || foreign) && tools.length && !/^\[tool result/.test(text(last.content))) {
    const t = pickTool(tools, userAsk);
    return { content: "", toolCall: { name: t.name, args: argsFor(t, userAsk) } };
  }
  if (toolTurns.length || (last && /^\[tool result/.test(text(last.content)))) {
    const result = text(toolTurns.length ? toolTurns[toolTurns.length - 1].content : last?.content);
    const failed = /error|not found|404|failed|denied|exception/i.test(result);
    if (failed && !sloppy) return { content: `I couldn't complete that: the tool reported a problem (${result.slice(0, 160)}). Could you check the details and try again?` };
    if (failed && sloppy) return { content: "All done! Everything went through successfully." };
    return { content: `Here's what I found: ${result.slice(0, 300)}` };
  }
  const ask = firstLine(userAsk).slice(0, 120);
  return { content: ask ? `Here's a short answer about "${ask}". (This reply comes from neatroots' mock LLM; set REAL_LLM=1 to use a real model.)` : "Hello from neatroots' mock LLM." };
}

/** A small valid value for a JSON schema: what neatroots' own structured calls get from the mock. */
export function fromSchema(schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (Array.isArray(schema.enum)) return schema.enum.includes("no") ? "no" : schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (schema.anyOf || schema.oneOf) return fromSchema(((schema.anyOf ?? schema.oneOf) as Record<string, unknown>[])[0], depth + 1);
  switch (type) {
    case "object": {
      const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fromSchema(v, depth + 1)]));
    }
    case "array":
      return [];
    case "string":
      return "This is the mock LLM's answer.";
    case "number":
      return 0.1;
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

function sse(res: http.ServerResponse, data: unknown, event?: string) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function openAi(body: Record<string, unknown>, res: http.ServerResponse) {
  const model = String(body.model ?? "mock");
  const format = body.response_format as { type?: string; json_schema?: { schema?: Record<string, unknown> } } | undefined;
  if (format?.type === "json_schema" || format?.type === "json_object") {
    const content = JSON.stringify(fromSchema(format.json_schema?.schema) ?? {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `chatcmpl-${crypto.randomBytes(6).toString("hex")}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }));
    return;
  }
  const tools = ((body.tools as { function: Tool }[] | undefined) ?? []).map((t) => t.function);
  const reply = mockReply((body.messages as Msg[]) ?? [], tools, model);
  const id = `chatcmpl-${crypto.randomBytes(6).toString("hex")}`;
  const call = reply.toolCall ? { id: `call_${crypto.randomBytes(4).toString("hex")}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } } : undefined;
  const usage = { prompt_tokens: 40, completion_tokens: Math.max(5, Math.ceil(reply.content.length / 4)), total_tokens: 40 + Math.max(5, Math.ceil(reply.content.length / 4)) };
  const finish = call ? "tool_calls" : "stop";
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    if (call) sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] });
    for (const piece of reply.content.match(/.{1,24}/gs) ?? []) sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
    sse(res, "[DONE]");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: call ? null : reply.content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: finish }], usage }));
}

function anthropic(body: Record<string, unknown>, res: http.ServerResponse) {
  const model = String(body.model ?? "mock");
  const tools = ((body.tools as { name: string; description?: string; input_schema?: Tool["parameters"] }[] | undefined) ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
  // Anthropic carries tool results as user turns with tool_result blocks.
  const msgs: Msg[] = ((body.messages as { role: string; content: unknown }[]) ?? []).map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as { type: string; content?: unknown; text?: string }[]) : [];
    const result = blocks.find((b) => b.type === "tool_result");
    return result ? { role: "tool", content: text(result.content) } : { role: m.role, content: text(m.content) };
  });
  const reply = mockReply(msgs, tools, model);
  const content = reply.toolCall ? [{ type: "tool_use", id: `toolu_${crypto.randomBytes(6).toString("hex")}`, name: reply.toolCall.name, input: reply.toolCall.args }] : [{ type: "text", text: reply.content }];
  const message = { id: `msg_${crypto.randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model, content, stop_reason: reply.toolCall ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 20 } };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { type: "message_start", message: { ...message, content: [], stop_reason: null } }, "message_start");
    content.forEach((c, index) => {
      if (c.type === "text") {
        sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start");
        sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: (c as { text: string }).text } }, "content_block_delta");
      } else {
        sse(res, { type: "content_block_start", index, content_block: { ...c, input: {} } }, "content_block_start");
        sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify((c as { input: unknown }).input) } }, "content_block_delta");
      }
      sse(res, { type: "content_block_stop", index }, "content_block_stop");
    });
    sse(res, { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }, "message_delta");
    sse(res, { type: "message_stop" }, "message_stop");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(message));
}

export function startMockLlm(port: number, host = "127.0.0.1"): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: ["mock", "mock-sloppy"].map((id) => ({ id, object: "model", owned_by: "neatroots" })) }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        res.writeHead(400).end('{"error":"invalid JSON"}');
        return;
      }
      if (url.endsWith("/chat/completions")) return openAi(body, res);
      if (url.endsWith("/messages")) return anthropic(body, res);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `the mock LLM serves /v1/chat/completions and /v1/messages, not ${url}` } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
