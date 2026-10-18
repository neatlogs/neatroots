export type API = "chat" | "responses" | "anthropic";
export function partialEvents(api: API): unknown[] {
  if (api === "chat") return [
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: "Hel" } }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: null, delta: { content: "lo", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"id":' } }] } }] },
  ];
  if (api === "responses") return [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call_a", name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"id":' },
  ];
  return [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"id":' } },
  ];
}
export function completeEvents(api: API): unknown[] {
  const prefix = partialEvents(api);
  if (api === "chat") return [...prefix,
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "7}" } }] }, finish_reason: "tool_calls" }, { index: 1, delta: { role: "assistant", content: "Alt", tool_calls: [{ index: 0, id: "call_b", type: "function", function: { name: "log", arguments: '{"ok":true}' } }] }, finish_reason: "stop" }] },
    { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  if (api === "responses") return [...prefix,
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "7}" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call_a", name: "lookup", arguments: '{"id":7}' } },
    { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
    { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "Alt" }] } },
    { type: "response.output_item.done", output_index: 3, item: { type: "function_call", call_id: "call_b", name: "log", arguments: '{"ok":true}' } },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ];
  return [...prefix,
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "7}" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "Alt" } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call_b", name: "log", input: { ok: true } } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
}
