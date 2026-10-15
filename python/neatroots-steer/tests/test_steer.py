import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import neatroots_steer
from neatroots_steer import _client


class StubRoots:
    """A tiny stand-in for the neatroots steering API."""

    def __init__(self, notes=None, mode="advisory"):
        self.notes = list(notes or [])
        self.mode = mode
        self.modes = {}
        self.claims = []
        self.checks = []
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
                    out = {"mode": stub.modes.get(body["trace_id"], stub.mode), "note": note}
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


def test_halt_note_raises(stub):
    stub.notes[:] = [{"id": "h", "kind": "halt", "text": "Your rule says stop.", "finding_id": None}]
    with pytest.raises(neatroots_steer.NeatrootsHalt):
        neatroots_steer.apply([{"role": "user", "content": "q"}])


def test_each_run_resolves_its_own_mode(stub):
    off, gate = "c" * 32, "d" * 32
    stub.modes = {off: "off", gate: "gate"}
    pending = stub.notes[:]
    stub.notes.clear()
    assert neatroots_steer.guidance(off) is None
    stub.notes[:] = pending
    # Another project's run is not skipped because the first project has steering off,
    # and as a run not seen before it flushes and waits like any new run.
    note = neatroots_steer.guidance(gate)
    assert note is not None and note.id == "n1"
    assert stub.claims[1]["gate_ms"] == 300
    assert neatroots_steer.guidance(off) is None
    assert [c["trace_id"] for c in stub.claims] == [off, gate]


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
