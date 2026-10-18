import http from "node:http";
export const chat = { id: "chat_local", object: "chat.completion", created: 1, model: "local", choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
export const message = { id: "msg_local", type: "message", role: "assistant", model: "local", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } };
export const response = { id: "resp_local", object: "response", created_at: 1, status: "completed", error: null, incomplete_details: null, model: "local", output: [{ type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
export async function fixture() {
  let customEvents: unknown[] | undefined;
  const requests: { path: string; body: Record<string, any>; header?: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    if (req.url === "/api/steer/claim") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ mode: "advisory", note: { id: "n", kind: "template", text: "Check once.", finding_id: null } }));
      return;
    }
    requests.push({ path: req.url!, body, header: req.headers["x-fixture"] as string });
    res.setHeader("x-request-id", "req_real");
    res.setHeader("request-id", "req_real");
    if (body.model === "reject") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "fixture rejection" } })); return; }
    if (body.model === "wait") { req.on("close", () => res.destroy()); return; }
    if (!body.stream) {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.endsWith("/messages") ? message : req.url === "/responses" ? response : chat));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let events: unknown[];
    if (req.url?.endsWith("/messages")) events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }, { type: "message_stop" },
    ];
    else if (req.url === "/responses") events = [{ type: "response.completed", response, sequence_number: 1 }];
    else events = [{ ...chat, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }];
    if (customEvents) events = customEvents;
    for (const event of events) res.write(`event: ${(event as any).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`);
    if (req.url === "/chat/completions") res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return { url, requests, setEvents: (events: unknown[]) => { customEvents = events; }, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
