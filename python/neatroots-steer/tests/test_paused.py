import sys
import threading
import time
import types
from unittest.mock import Mock

import pytest

import neatroots_steer

TRACE = "a" * 32


@pytest.fixture
def flush(monkeypatch):
    flush = Mock()
    monkeypatch.setattr(neatroots_steer, "_flush_sdk", flush)
    monkeypatch.setattr(neatroots_steer, "current_trace", lambda: (TRACE, None))
    return flush


def test_off_by_env_does_not_flush(monkeypatch, flush):
    monkeypatch.setenv("NEATROOTS_STEER", "off")
    neatroots_steer.configure("http://127.0.0.1:9", listen=False)
    assert neatroots_steer.guidance() is None
    assert neatroots_steer.check_my_work("Did I verify the order?")["answer"] == "unknown"
    # was: neatlogs.flush() before every call, seconds each when the SDK's collector is down
    flush.assert_not_called()


def test_backing_off_from_a_stopped_neatroots_does_not_flush(monkeypatch, flush):
    monkeypatch.delenv("NEATROOTS_STEER", raising=False)
    neatroots_steer.configure("http://127.0.0.1:9", listen=False)  # nothing listens: neatroots is stopped
    assert neatroots_steer.guidance() is None
    assert flush.call_count == 1  # the first call can't know yet
    for _ in range(3):
        assert neatroots_steer.guidance() is None
    assert neatroots_steer.check_my_work("Did I verify the order?")["answer"] == "unknown"
    assert flush.call_count == 1


def test_a_slow_sdk_flush_holds_the_call_at_most_half_a_second(monkeypatch):
    release = threading.Event()
    calls = []

    def slow_flush():  # neatlogs.flush() with its collector down: seconds, whatever its timeout
        calls.append(1)
        release.wait(3)

    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=slow_flush))
    try:
        started = time.monotonic()
        neatroots_steer._flush_sdk()
        neatroots_steer._flush_sdk()  # the first flush is still running, so it isn't started again
        assert time.monotonic() - started < 1.5
        assert len(calls) == 1
    finally:
        release.set()
        flushing = getattr(neatroots_steer, "_flushing", None)
        if flushing is not None:
            flushing.join(5)


def test_a_quick_sdk_flush_finishes_before_the_call_goes_on(monkeypatch):
    calls = []
    monkeypatch.setitem(sys.modules, "neatlogs", types.SimpleNamespace(flush=lambda: calls.append(1)))
    neatroots_steer._flush_sdk()
    assert calls == [1]  # gate mode still sees the latest step
