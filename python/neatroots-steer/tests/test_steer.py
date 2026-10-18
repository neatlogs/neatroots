import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import neatroots_steer
from neatroots_steer import _client


class StubRoots:
    """A tiny stand-in for the neatroots steering API."""

    def __init__(self, notes=None, mode="advisory"):
        self.notes = list(notes or [])
        self.mode = mode
        self.claims = []
        self.checks = []
        self.slow = []  # seconds to hold the next claim replies (a busy neatroots)
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if self.path == "/api/steer/claim":
                    stub.claims.append(body)
                    note = stub.notes.pop(0) if stub.notes else None
                    out = {"mode": stub.mode, "note": note}
                    if stub.slow:
                        time.sleep(stub.slow.pop(0))
                elif self.path == "/api/steer/check":
                    stub.checks.append(body)
                    out = {"probability": 0.9, "answer": "yes", "evidence_span_ids": ["abc"]}
                else:
                    out = {}
                data = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def stub(monkeypatch):
    s = StubRoots(notes=[{"id": "n1", "kind": "template", "text": "Stop retrying.", "finding_id": "f1"}])
    neatroots_steer.configure(s.url, listen=False)
    monkeypatch.setattr(neatroots_steer, "current_trace", lambda: ("a" * 32, "b" * 16))
    yield s
    s.close()


def test_apply_appends_note_to_last_user_message(stub):
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]
    out = neatroots_steer.apply(msgs)
    assert msgs[-1]["content"] == "hi"  # input untouched
    assert "<neatroots-guidance>" in out[-1]["content"] and "Stop retrying." in out[-1]["content"]
    assert stub.claims[0]["trace_id"] == "a" * 32


def test_apply_adds_user_turn_after_tool_result(stub):
    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": None}, {"role": "tool", "content": "{}", "tool_call_id": "c"}]
    out = neatroots_steer.apply(msgs)
    assert len(out) == 4 and out[-1]["role"] == "user"


def test_apply_anthropic_joins_tool_result_turn(stub):
    msgs = [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}]
    out = neatroots_steer.apply_anthropic(msgs)
    assert out[-1]["content"][-1]["type"] == "text"
    assert "<neatroots-guidance>" in out[-1]["content"][-1]["text"]


def test_no_note_leaves_messages_unchanged(stub):
    stub.notes.clear()
    msgs = [{"role": "user", "content": "hi"}]
    assert neatroots_steer.apply(msgs) is msgs


def test_wrap_injects_into_chat_completions(stub):
    seen = {}

    class Completions:
        def create(self, **kw):
            seen.update(kw)
            return "ok"

    class Chat:
        completions = Completions()

    class Client:
        chat = Chat()

    c = neatroots_steer.wrap(Client())
    assert c.chat.completions.create(model="m", messages=[{"role": "user", "content": "q"}]) == "ok"
    assert "<neatroots-guidance>" in seen["messages"][-1]["content"]
    # wrapping twice is harmless
    neatroots_steer.wrap(c)


def test_wrap_covers_stream_and_parse(stub):
    """stream() and parse() don't go through create, so a halt must reach them on its own."""
    calls = []

    class Messages:
        def create(self, **kw):
            calls.append("create")

        def stream(self, **kw):
            calls.append("stream")

        def parse(self, **kw):
            calls.append("parse")

    class Client:
        messages = Messages()

    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}] * 3
    client = neatroots_steer.wrap(Client())
    for method in (client.messages.create, client.messages.stream, client.messages.parse):
        with pytest.raises(neatroots_steer.NeatrootsHalt):
            method(messages=[{"role": "user", "content": "q"}])
    assert calls == []  # the model was never reached


def test_wrap_covers_parse_but_leaves_openai_stream_to_create(stub):
    calls = []

    class Completions:
        def create(self, **kw):
            calls.append(kw)

        def parse(self, **kw):
            calls.append(kw)

        def stream(self, **kw):
            self.create(**kw)  # the SDK's stream() goes through create

    class Chat:
        completions = Completions()

    class Responses:
        def create(self, **kw):
            calls.append(kw)

        def parse(self, **kw):
            calls.append(kw)

    class Client:
        chat = Chat()
        responses = Responses()

    halt = {"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}
    stub.notes[:] = [halt] * 3
    client = neatroots_steer.wrap(Client())
    with pytest.raises(neatroots_steer.NeatrootsHalt):
        client.chat.completions.parse(messages=[{"role": "user", "content": "q"}])
    with pytest.raises(neatroots_steer.NeatrootsHalt):
        client.responses.parse(input="q")
    assert calls == []
    # stream() is not wrapped on its own, or the claim would run twice
    before = len(stub.claims)
    stub.notes[:] = [{"id": "n", "kind": "template", "text": "Stop retrying.", "finding_id": None}]
    client.chat.completions.stream(messages=[{"role": "user", "content": "q"}])
    assert len(stub.claims) == before + 1
    assert "<neatroots-guidance>" in calls[-1]["messages"][-1]["content"]


def test_wrap_covers_clients_from_with_options_and_copy(stub):
    calls = []

    def make_client():
        class Completions:
            def create(self, **kw):
                calls.append(kw)

        class Chat:
            completions = Completions()

        class Client:
            chat = Chat()

            def with_options(self, **kw):
                return make_client()

            def copy(self, **kw):
                return make_client()

        return Client()

    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}] * 2
    client = neatroots_steer.wrap(make_client())
    for derived in (client.with_options(timeout=5), client.copy()):
        with pytest.raises(neatroots_steer.NeatrootsHalt):
            derived.chat.completions.create(messages=[{"role": "user", "content": "q"}])
    assert calls == []
    stub.notes[:] = [{"id": "n", "kind": "template", "text": "Check the order.", "finding_id": None}]
    client.with_options().chat.completions.create(messages=[{"role": "user", "content": "q"}])
    assert "<neatroots-guidance>" in calls[-1]["messages"][-1]["content"]


def test_halt_note_raises(stub):
    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}]
    with pytest.raises(neatroots_steer.NeatrootsHalt):
        neatroots_steer.apply([{"role": "user", "content": "q"}])


def test_note_ignored_when_steering_off(stub):
    stub.mode = "off"
    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}]
    msgs = [{"role": "user", "content": "q"}]
    assert neatroots_steer.apply(msgs) == msgs


def test_one_slow_reply_does_not_hold_back_a_halt(stub):
    stub.notes[:] = []
    stub.slow[:] = [1.2]  # longer than the hook waits
    msgs = [{"role": "user", "content": "q"}]
    assert neatroots_steer.apply(msgs) is msgs
    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}]
    # was: every call for the next 5 s skipped neatroots, so the halt never arrived
    with pytest.raises(neatroots_steer.NeatrootsHalt):
        neatroots_steer.apply([{"role": "user", "content": "again"}])


def test_backs_off_after_a_few_slow_replies_in_a_row(stub):
    stub.notes[:] = []
    stub.slow[:] = [1.2, 1.2, 1.2]
    for _ in range(3):
        neatroots_steer.apply([{"role": "user", "content": "q"}])
    sent = len(stub.claims)
    neatroots_steer.apply([{"role": "user", "content": "q"}])
    assert len(stub.claims) == sent  # skipped: neatroots is treated as stuck for a while


def test_check_my_work_and_tool_call(stub):
    r = neatroots_steer.check_my_work("Did I verify the order?")
    assert r["probability_yes"] == 0.9 and r["answer"] == "yes"
    out = json.loads(neatroots_steer.handle_tool_call("check_my_work", json.dumps({"question": "Q?"})))
    assert out["evidence_span_ids"] == ["abc"]
    assert neatroots_steer.handle_tool_call("other_tool", "{}") is None
    assert neatroots_steer.CHECK_MY_WORK_TOOL["function"]["name"] == "check_my_work"


def test_unreachable_neatroots_is_silent(monkeypatch):
    neatroots_steer.configure("http://127.0.0.1:9", listen=False)
    monkeypatch.setattr(neatroots_steer, "current_trace", lambda: ("a" * 32, None))
    msgs = [{"role": "user", "content": "q"}]
    assert neatroots_steer.apply(msgs) is msgs
    assert neatroots_steer.check_my_work("q")["answer"] == "unknown"


def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("NEATROOTS_STEER", "off")
    c = _client.RootsClient("http://127.0.0.1:9", listen=False)
    assert c.claim("a" * 32) is None


def test_default_url_follows_local_endpoint(monkeypatch):
    monkeypatch.delenv("NEATROOTS_URL", raising=False)
    monkeypatch.setenv("NEATLOGS_ENDPOINT", "http://localhost:4123")
    assert _client._default_url() == "http://localhost:4123"
    monkeypatch.setenv("NEATLOGS_ENDPOINT", "https://ingest.neatlogs.com")
    assert _client._default_url() == "http://localhost:4100"


def test_replay_input_and_overrides(monkeypatch, stub):
    assert neatroots_steer.replay_input("original") == "original"
    monkeypatch.setenv("NEATROOTS_REPLAY_INPUT", "edited question")
    monkeypatch.setenv("NEATROOTS_REPLAY_MODEL", "small-model")
    monkeypatch.setenv("NEATROOTS_REPLAY_SYSTEM_PROMPT", "Be brief.")
    assert neatroots_steer.replay_input("original") == "edited question"
    seen = {}

    class Completions:
        def create(self, **kw):
            seen.update(kw)
            return "ok"

    class Chat:
        completions = Completions()

    class Client:
        chat = Chat()

    client = neatroots_steer.wrap(Client())
    client.chat.completions.create(model="big-model", messages=[{"role": "system", "content": "Long rules"}, {"role": "user", "content": "hi"}])
    assert seen["model"] == "small-model"
    assert seen["messages"][0] == {"role": "system", "content": "Be brief."}
