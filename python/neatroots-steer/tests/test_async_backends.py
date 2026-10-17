"""Backend compatibility without provider traffic or pytest async plugins."""

import contextvars
import functools
import threading
from types import SimpleNamespace

import anyio
import pytest

import neatroots_steer as steer
from test_async import client_for


@pytest.fixture(params=["asyncio", "trio", "anyio-trio"])
def run_backend(request):
    if request.param == "trio":
        return pytest.importorskip("trio").run
    if request.param == "anyio-trio":
        pytest.importorskip("trio")
        return lambda fn: anyio.run(fn, backend="trio")
    return anyio.run


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
@pytest.mark.parametrize("blocked_phase", ["flush", "claim"])
def test_backend_preparation_yields_with_context(monkeypatch, run_backend, provider, blocked_phase):
    active = contextvars.ContextVar("trace")
    entered, release = threading.Event(), threading.Event()
    seen = []
    main_thread = threading.get_ident()

    def phase(name):
        seen.append((name, active.get(), threading.get_ident()))
        if name == blocked_phase:
            entered.set()
            assert release.wait(2)

    def claim(*args, **kwargs):
        phase("claim")
        return steer.Note("n", "template", "Check the order.", None)

    monkeypatch.setattr(steer, "current_trace", lambda: active.get())
    monkeypatch.setattr(steer, "_flush_sdk", lambda: phase("flush"))
    monkeypatch.setattr(steer, "_record", lambda _: phase("record"))
    monkeypatch.setattr(steer, "get_client", lambda: SimpleNamespace(mode_for=lambda _: "gate", claim=claim))

    async def create(**kwargs):
        seen.append(("model", active.get(), threading.get_ident()))
        assert "Check the order." in kwargs["messages"][-1]["content"]

    @functools.wraps(create)
    def decorated(**kwargs):
        return create(**kwargs)

    client, resource = client_for(provider, decorated)
    steer.wrap(client)

    async def run():
        token = active.set(("a" * 32, "b" * 16))
        messages = [{"role": "user", "content": "hi"}]
        watchdog = threading.Timer(1, release.set)
        watchdog.start()
        try:
            async with anyio.create_task_group() as group:
                group.start_soon(functools.partial(resource.create, messages=messages))
                with anyio.fail_after(2):
                    while not entered.is_set():
                        await anyio.sleep(0)
                assert not release.is_set(), "preparation blocked the backend"
                release.set()
            assert messages == [{"role": "user", "content": "hi"}]
        finally:
            release.set()
            watchdog.cancel()
            active.reset(token)

    run_backend(run)
    assert [s[0] for s in seen] == ["flush", "claim", "record", "model"]
    assert all(s[1] == ("a" * 32, "b" * 16) for s in seen)
    assert all(s[2] != main_thread for s in seen[:-1])
    assert seen[-1][2] == main_thread


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_backend_cancellation_abandons_preparation(monkeypatch, run_backend, provider):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def guidance():
        entered.set()
        try:
            assert release.wait(2)
        finally:
            finished.set()

    async def create(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(steer, "guidance", guidance)
    client, resource = client_for(provider, create)
    steer.wrap(client)

    async def run():
        watchdog = threading.Timer(1, release.set)
        watchdog.start()
        try:
            async with anyio.create_task_group() as group:
                group.start_soon(functools.partial(resource.create, messages=[]))
                with anyio.fail_after(2):
                    while not entered.is_set():
                        await anyio.sleep(0)
                group.cancel_scope.cancel()
            assert not release.is_set(), "cancellation waited for synchronous I/O"
        finally:
            release.set()
            watchdog.cancel()
        with anyio.fail_after(2):
            while not finished.is_set():
                await anyio.sleep(0)
        assert calls == []

    run_backend(run)


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_backend_halt_fail_open_and_provider_error(monkeypatch, run_backend, provider):
    calls = []

    async def create(**kwargs):
        calls.append(kwargs)
        raise ValueError("provider rejected request")

    client, resource = client_for(provider, create)
    steer.wrap(client)

    def halt():
        raise steer.NeatrootsHalt("stop")

    def unavailable():
        raise OSError("offline")

    async def run():
        monkeypatch.setattr(steer, "guidance", halt)
        with pytest.raises(steer.NeatrootsHalt, match="stop"):
            await resource.create(messages=[])
        assert calls == []
        monkeypatch.setattr(steer, "guidance", unavailable)
        with pytest.raises(ValueError, match="provider rejected request"):
            await resource.create(messages=[])
        assert calls == [{"messages": []}]

    run_backend(run)
