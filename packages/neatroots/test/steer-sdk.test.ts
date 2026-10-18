import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, NeatrootsHalt, wrapAnthropic } from "../../steer-ts/src/index.js";

const params = { model: "test-model", max_tokens: 8, messages: [{ role: "user" as const, content: "hi" }] };
const note = { id: "n1", kind: "template", text: "Check the order first.", finding_id: "f1" };

function provider() {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
    id: "msg_test", type: "message", role: "assistant", model: "test-model",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { headers: { "content-type": "application/json", "request-id": "local-test" } }));
  const client = new Anthropic({ apiKey: "test-local-only", fetch, maxRetries: 0 });
  return { client: wrapAnthropic(client), fetch };
}

beforeEach(() => {
  configure({ disabled: false, url: "http://127.0.0.1:4100", traceId: () => "a".repeat(32), neatlogs: {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ mode: "advisory", note })));
});
afterEach(() => {
  configure({ disabled: false });
  vi.unstubAllGlobals();
});

describe("steered SDK response helpers", () => {
  it.each([false, true])("preserves withResponse with steering disabled=%s", async (disabled) => {
    configure({ disabled });
    const { client, fetch } = provider();
    const request = client.messages.create(params);
    const { data, response, request_id } = await request.withResponse();
    expect(data.id).toBe("msg_test");
    expect(response.status).toBe(200);
    expect(request_id).toBe("local-test");
    expect(await request).toBe(data);
    expect(await request.then((message) => message.id)).toBe("msg_test");
    const done = vi.fn();
    expect(await request.finally(done)).toBe(data);
    expect(done).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.messages[0].content.includes("<neatroots-guidance>")).toBe(!disabled);
  });

  it.each([false, true])("leaves the raw response body unread with steering disabled=%s", async (disabled) => {
    configure({ disabled });
    const { client, fetch } = provider();
    const response = await client.messages.create(params).asResponse();
    expect(response.bodyUsed).toBe(false);
    expect((await response.json()).id).toBe("msg_test");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["withResponse", "asResponse"] as const)("honors halt before calling the provider through %s", async (helper) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ mode: "gate", note: { ...note, kind: "halt" } })));
    const { client, fetch } = provider();
    await expect(client.messages.create(params)[helper]()).rejects.toBeInstanceOf(NeatrootsHalt);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates provider failures through helpers and catch", async () => {
    const { client, fetch } = provider();
    fetch.mockImplementation(async () => Response.json({ error: { type: "api_error", message: "test failure" } }, { status: 503 }));
    const request = client.messages.create(params);
    await expect(request.withResponse()).rejects.toThrow("test failure");
    await expect(request.catch((error: Error) => error.message)).resolves.toContain("test failure");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
