import json
from unittest.mock import Mock

import pytest

import neatroots_steer
from neatroots_steer import _client

FIRST_TRACE = "a" * 32
GATE_TRACE = "b" * 32
NOTE = {"id": "n1", "kind": "template", "text": "Check the order first.", "finding_id": "f1"}


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.delenv("NEATROOTS_STEER", raising=False)
    client = neatroots_steer.configure(listen=False)
    flush = Mock()
    monkeypatch.setattr(neatroots_steer, "_flush_sdk", flush)
    monkeypatch.setattr(neatroots_steer, "_record", Mock())
    return client, flush


@pytest.mark.parametrize("first_mode", ["off", "advisory", "self-check"])
def test_new_run_resolves_and_flushes_its_own_mode(setup, monkeypatch, first_mode):
    client, flush = setup
    client._sse_connected = True
    post = Mock(side_effect=lambda path, body, timeout: {
        "mode": first_mode if body["trace_id"] == FIRST_TRACE else "gate",
        "note": None if body["trace_id"] == FIRST_TRACE else NOTE,
    })
    monkeypatch.setattr(client, "_post", post)
    assert neatroots_steer.guidance(FIRST_TRACE) is None
    note = neatroots_steer.guidance(GATE_TRACE)
    assert note is not None and note.id == "n1"
    assert post.call_count == 2
    assert post.call_args.args[1]["gate_ms"] == 300
    assert flush.call_count == 2
    assert client.mode == "gate"  # Keep the existing last-claimed-mode property compatible.


def test_off_is_still_cached_for_the_same_run(setup, monkeypatch):
    client, flush = setup
    post = Mock(return_value={"mode": "off", "note": None})
    monkeypatch.setattr(client, "_post", post)
    neatroots_steer.guidance(FIRST_TRACE)
    neatroots_steer.guidance(FIRST_TRACE)
    assert post.call_count == 1
    assert flush.call_count == 1


def test_mode_event_invalidates_the_cached_mode_and_flushes_again(setup, monkeypatch):
    client, flush = setup
    post = Mock(return_value={"mode": "off", "note": None})
    monkeypatch.setattr(client, "_post", post)
    neatroots_steer.guidance(FIRST_TRACE)
    client._on_event("mode", json.dumps({"project": "first", "mode": "gate"}))
    post.return_value = {"mode": "gate", "note": NOTE}
    assert neatroots_steer.guidance(FIRST_TRACE).id == "n1"
    assert post.call_args.args[1]["gate_ms"] == 300
    assert flush.call_count == 2


def test_global_disabled_hello_is_cached_across_traces_then_rechecked(setup, monkeypatch):
    client, flush = setup
    post = Mock(return_value={"mode": "gate", "note": NOTE})
    monkeypatch.setattr(client, "_post", post)
    now = _client.time.monotonic()
    client._on_event("hello", json.dumps({"enabled": False}))
    assert neatroots_steer.guidance(FIRST_TRACE) is None
    assert neatroots_steer.guidance(GATE_TRACE) is None
    post.assert_not_called()
    flush.assert_not_called()
    monkeypatch.setattr(_client.time, "monotonic", lambda: now + 11)
    assert neatroots_steer.guidance(GATE_TRACE).id == "n1"
    assert post.call_args.args[1]["gate_ms"] == 300
