"""Optional real SDK smoke tests: no provider requests or API keys are needed."""

import contextvars
import json
import threading

import pytest

import neatroots_steer as steer
from test_async_backends import run_backend


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_real_async_sdk_create_preserves_guidance_and_context(monkeypatch, provider, run_backend):
    sdk = pytest.importorskip(provider)
    # Match the installed SDK's transport family (recent Anthropic uses httpx2).
    transport_package = next(base.__module__.split(".")[0] for base in sdk.DefaultAsyncHttpxClient.__mro__ if base.__name__ == "AsyncClient")
    httpx = pytest.importorskip(transport_package)
    active_trace = contextvars.ContextVar("trace")
    main_thread = threading.get_ident()
    received = []

    def guidance():
        assert threading.get_ident() != main_thread
        assert active_trace.get() == "sdk-smoke-trace"
        return steer.Note("sdk-note", "template", "Verify the order.", None)

    monkeypatch.setattr(steer, "guidance", guidance)

    async def handle(request):
        body = json.loads(request.content)
        received.append(body)
        assert body["messages"][-1]["content"].endswith("</neatroots-guidance>")
        assert "Verify the order." in body["messages"][-1]["content"]
        if provider == "openai":
            response = {"id": "chatcmpl-local", "object": "chat.completion", "created": 1, "model": "local-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "checked"}, "finish_reason": "stop"}]}
        else:
            response = {"id": "msg_local", "type": "message", "role": "assistant", "model": "local-model", "content": [{"type": "text", "text": "checked"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
        return httpx.Response(200, json=response)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as transport:
            cls = sdk.AsyncOpenAI if provider == "openai" else sdk.AsyncAnthropic
            client = steer.wrap(cls(api_key="local-fixture", base_url="http://local-fixture.invalid/v1", http_client=transport))
            messages = [{"role": "user", "content": "hello"}]
            token = active_trace.set("sdk-smoke-trace")
            try:
                if provider == "openai":
                    response = await client.chat.completions.create(model="local-model", messages=messages)
                    assert response.choices[0].message.content == "checked"
                else:
                    response = await client.messages.create(model="local-model", messages=messages, max_tokens=8)
                    assert response.content[0].text == "checked"
            finally:
                active_trace.reset(token)
                await client.close()
            assert messages == [{"role": "user", "content": "hello"}]
        assert len(received) == 1

    run_backend(run)
