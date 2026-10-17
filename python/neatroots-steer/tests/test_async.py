import asyncio
import contextvars
import threading
from types import SimpleNamespace

import pytest

import neatroots_steer as steer


def client_for(provider, create):
    resource = SimpleNamespace(create=create)
    if provider == "openai":
        return SimpleNamespace(chat=SimpleNamespace(completions=resource)), resource
    return SimpleNamespace(messages=resource), resource


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
@pytest.mark.parametrize("blocked_phase", ["flush", "claim"])
def test_async_preparation_yields_and_preserves_context(monkeypatch, provider, blocked_phase):
    trace = contextvars.ContextVar("trace")
    entered = threading.Event()
    release = threading.Event()
    seen = []
    main_thread = threading.get_ident()

    def phase(name):
        seen.append((name, trace.get(), threading.get_ident()))
        if name == blocked_phase:
            entered.set()
            assert release.wait(2), "test failed to release preparation"

    def claim(*args, **kwargs):
        phase("claim")
        assert args == ("a" * 32, "b" * 16)
        return steer.Note("n", "template", "Check the order.", None)

    monkeypatch.setattr(steer, "current_trace", lambda: trace.get())
    monkeypatch.setattr(steer, "_flush_sdk", lambda: phase("flush"))
    monkeypatch.setattr(steer, "_record", lambda note: phase("record"))
    monkeypatch.setattr(steer, "get_client", lambda: SimpleNamespace(mode_for=lambda _: "gate", claim=claim))

    async def create(**kwargs):
        seen.append(("model", trace.get(), threading.get_ident()))
        return kwargs

    client, resource = client_for(provider, create)
    steer.wrap(client)

    async def run():
        token = trace.set(("a" * 32, "b" * 16))
        messages = [{"role": "user", "content": "hello"}]
        # A watchdog releases blocking I/O even on the broken implementation,
        # so failure is an assertion rather than a hung test process.
        watchdog = threading.Timer(1, release.set)
        watchdog.start()
        try:
            task = asyncio.create_task(resource.create(messages=messages))
            while not entered.is_set():
                await asyncio.sleep(0)
            responsive = not release.is_set() and not task.done()
            release.set()
            result = await task
            assert responsive, "claim/flush blocked the asyncio event loop"
            assert "Check the order." in result["messages"][-1]["content"]
            assert messages == [{"role": "user", "content": "hello"}]
        finally:
            release.set()
            watchdog.cancel()
            trace.reset(token)

    asyncio.run(run())
    assert [s[0] for s in seen] == ["flush", "claim", "record", "model"]
    assert all(s[1] == ("a" * 32, "b" * 16) for s in seen)
    assert all(s[2] != main_thread for s in seen[:-1])
    assert seen[-1][2] == main_thread


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_async_halt_and_fail_open_semantics(monkeypatch, provider):
    calls = []

    async def create(**kwargs):
        calls.append(kwargs)
        return "ok"

    client, resource = client_for(provider, create)
    steer.wrap(client)

    def halt():
        raise steer.NeatrootsHalt("stop")

    monkeypatch.setattr(steer, "guidance", halt)

    async def run():
        with pytest.raises(steer.NeatrootsHalt, match="stop"):
            await resource.create(messages=[])
        assert calls == []
        def unavailable():
            raise OSError("offline")
        monkeypatch.setattr(steer, "guidance", unavailable)
        assert await resource.create(messages=[]) == "ok"
        assert calls == [{"messages": []}]

    asyncio.run(run())


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_cancelled_preparation_does_not_call_model(monkeypatch, provider):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def guidance():
        entered.set()
        assert release.wait(2)
        return None

    async def create(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(steer, "guidance", guidance)
    client, resource = client_for(provider, create)
    steer.wrap(client)

    async def run():
        watchdog = threading.Timer(1, release.set)
        watchdog.start()
        try:
            task = asyncio.create_task(resource.create(messages=[]))
            while not entered.is_set():
                await asyncio.sleep(0)
            assert not task.done(), "preparation blocked cancellation"
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            release.set()
            watchdog.cancel()

    asyncio.run(run())
    assert calls == []

@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_concurrent_async_calls_keep_separate_traces(monkeypatch, provider):
    trace = contextvars.ContextVar("trace")
    barrier = threading.Barrier(2, timeout=2)
    recorded = []

    def guidance():
        active = trace.get()
        barrier.wait()
        recorded.append(active)
        return steer.Note(active, "template", active, None)

    async def create(**kwargs):
        assert trace.get() in kwargs["messages"][-1]["content"]
        await asyncio.sleep(0)
        if trace.get() == "second-trace":
            raise ValueError("provider rejected request")
        return trace.get()

    monkeypatch.setattr(steer, "guidance", guidance)
    client, resource = client_for(provider, create)
    steer.wrap(client)

    async def call(value):
        token = trace.set(value)
        try:
            return await resource.create(messages=[{"role": "user", "content": "hi"}])
        finally:
            trace.reset(token)

    async def run():
        results = await asyncio.gather(call("first-trace"), call("second-trace"), return_exceptions=True)
        assert results[0] == "first-trace"
        assert isinstance(results[1], ValueError)
        assert str(results[1]) == "provider rejected request"

    asyncio.run(run())
    assert sorted(recorded) == ["first-trace", "second-trace"]

@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_decorated_async_create_is_prepared_off_loop(monkeypatch, provider):
    import functools

    main_thread = threading.get_ident()
    active = contextvars.ContextVar("active")

    def guidance():
        assert threading.get_ident() != main_thread
        assert active.get() == "decorated-trace"
        return steer.Note("decorated", "template", "Keep this guidance.", None)

    async def create(**kwargs):
        assert "Keep this guidance." in kwargs["messages"][-1]["content"]
        return "ok"

    # Mirrors SDK argument-validation decorators without requiring SDK installs.
    @functools.wraps(create)
    def validated_create(**kwargs):
        return create(**kwargs)

    monkeypatch.setattr(steer, "guidance", guidance)
    client, resource = client_for(provider, validated_create)
    steer.wrap(client)

    async def run():
        token = active.set("decorated-trace")
        try:
            assert await resource.create(messages=[{"role": "user", "content": "hi"}]) == "ok"
        finally:
            active.reset(token)

    asyncio.run(run())

@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_unmarked_sync_callable_returning_awaitable_keeps_sync_contract(monkeypatch, provider):
    calls = []
    main_thread = threading.get_ident()

    def guidance():
        calls.append(threading.get_ident())
        return None

    async def response():
        return "ok"

    def create(**kwargs):
        return response()

    monkeypatch.setattr(steer, "guidance", guidance)
    client, resource = client_for(provider, create)
    steer.wrap(client)

    async def run():
        pending = resource.create(messages=[])
        assert calls == [main_thread]  # ordinary synchronous wrappers stay synchronous
        assert await pending == "ok"

    asyncio.run(run())
