"""Hook-owned flush/backoff guarantees without external services or SDK traffic."""

import contextvars
import io
import json
import sys
import threading
import time
import types
import urllib.error
from unittest.mock import Mock

import pytest

import neatroots_steer as steer
from neatroots_steer import _client

TRACE = "a" * 32


@pytest.fixture(autouse=True)
def isolated_worker(monkeypatch):
    previous = getattr(steer, "_flushing", None)
    if previous is not None:
        previous.join(2)
        assert not previous.is_alive()
    monkeypatch.setattr(steer, "_flushing", None, raising=False)
    monkeypatch.setattr(steer, "_FLUSH_TIMEOUT_MS", 40, raising=False)
    yield
    worker = steer._flushing
    if worker is not None:
        worker.join(2)
        assert not worker.is_alive(), "test must release its flush worker"


@pytest.mark.parametrize("value", ["off", "0", "false", "no", "OFF"])
def test_disabled_hook_never_starts_listener_flush_or_transport(monkeypatch, value):
    monkeypatch.setenv("NEATROOTS_STEER", value)
    listener, transport, flush = Mock(), Mock(), Mock()
    monkeypatch.setattr(_client.RootsClient, "_start_listener", listener)
    monkeypatch.setattr(_client.urllib.request, "urlopen", transport)
    monkeypatch.setattr(steer, "_flush_sdk", flush)
    monkeypatch.setattr(steer, "current_trace", lambda: (TRACE, None))
    client = steer.configure("http://local-fixture.invalid")  # listen=True by default
    assert client.disabled
    assert steer.guidance() is None
    assert steer.check_my_work("Verified?")["answer"] == "unknown"
    assert client.claim(TRACE) is None
    listener.assert_not_called()
    transport.assert_not_called()
    flush.assert_not_called()


def test_backoff_skips_flush_and_transport_then_recovers(monkeypatch):
    monkeypatch.delenv("NEATROOTS_STEER", raising=False)
    now = [100.0]
    monkeypatch.setattr(_client.time, "monotonic", lambda: now[0])
    transport = Mock(side_effect=[
        urllib.error.URLError(ConnectionRefusedError()),
        io.BytesIO(json.dumps({"mode": "gate", "note": None}).encode()),
    ])
    monkeypatch.setattr(_client.urllib.request, "urlopen", transport)
    flush = Mock()
    monkeypatch.setattr(steer, "_flush_sdk", flush)
    monkeypatch.setattr(steer, "current_trace", lambda: (TRACE, None))
    client = steer.configure(listen=False)
    assert steer.guidance() is None
    assert client.paused()
    for _ in range(3):
        assert steer.guidance() is None
        assert steer.check_my_work("Verified?")["answer"] == "unknown"
    assert flush.call_count == transport.call_count == 1
    now[0] += 5.01
    assert not client.paused()
    assert steer.guidance() is None
    assert client.mode_for(TRACE) == "gate"
    assert flush.call_count == transport.call_count == 2


def test_flush_worker_receives_originating_context(monkeypatch):
    active = contextvars.ContextVar("trace")
    seen = []
    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=lambda: seen.append(active.get())))
    token = active.set("originating-trace")
    try:
        steer._flush_sdk()
    finally:
        active.reset(token)
    assert seen == ["originating-trace"]


def test_fast_flush_finishes_before_claim_and_preserves_halt(monkeypatch):
    monkeypatch.delenv("NEATROOTS_STEER", raising=False)
    order = []
    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=lambda: order.append("flush")))
    monkeypatch.setattr(steer, "current_trace", lambda: (TRACE, None))
    monkeypatch.setattr(steer, "_record", lambda _: order.append("record"))
    client = steer.configure(listen=False)

    def claim(*args, **kwargs):
        assert order == ["flush"]
        assert kwargs["gate_ms"] == 300
        order.append("claim")
        return steer.Note("halt", "halt", "stop before provider", None)

    monkeypatch.setattr(client, "claim", claim)
    with pytest.raises(steer.NeatrootsHalt, match="stop before provider"):
        steer.guidance()
    assert order == ["flush", "claim", "record"]


def test_concurrent_waiters_share_one_bounded_flush(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []

    def blocked():
        calls.append(1)
        entered.set()
        release.wait(2)

    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=blocked))
    callers = [threading.Thread(target=steer._flush_sdk) for _ in range(4)]
    try:
        for caller in callers:
            caller.start()
        assert entered.wait(1)
        for caller in callers:
            caller.join(0.5)
        assert all(not caller.is_alive() for caller in callers)
        assert steer._flushing.is_alive()  # returning does not cancel the SDK worker
        assert calls == [1]
    finally:
        release.set()
        for caller in callers:
            caller.join(2)


def test_slow_sdk_cannot_hold_caller_for_its_full_duration(monkeypatch):
    release = threading.Event()
    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=lambda: release.wait(1)))
    try:
        started = time.monotonic()
        steer._flush_sdk()
        assert time.monotonic() - started < 0.5
        assert steer._flushing.is_alive()
    finally:
        release.set()


def test_flush_failure_uses_bounded_otel_fallback(monkeypatch):
    calls = []

    def failed():
        raise RuntimeError("SDK flush unavailable")

    provider = types.SimpleNamespace(force_flush=lambda timeout: calls.append(timeout))
    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=failed))
    monkeypatch.setitem(sys.modules, "opentelemetry", types.SimpleNamespace(
        trace=types.SimpleNamespace(get_tracer_provider=lambda: provider)))
    steer._flush_sdk()
    assert calls == [40]


def test_flush_and_fallback_failure_do_not_break_agent(monkeypatch):
    def failed(*args):
        raise RuntimeError("exporter stopped")

    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=failed))
    monkeypatch.setitem(sys.modules, "opentelemetry", types.SimpleNamespace(
        trace=types.SimpleNamespace(get_tracer_provider=failed)))
    steer._flush_sdk()
