"""Talks to a local neatroots app: claims guidance notes, listens for steering events, runs self-checks.

Everything here fails quietly. If neatroots is not running, the agent carries on unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Set, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("neatroots_steer")

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
_MAX_MODES = 1000


def _default_url() -> str:
    explicit = os.environ.get("NEATROOTS_URL")
    if explicit:
        return explicit.rstrip("/")
    endpoint = os.environ.get("NEATLOGS_ENDPOINT", "")
    if endpoint:
        parsed = urlparse(endpoint)
        if parsed.hostname in _LOCAL_HOSTS:
            return f"{parsed.scheme}://{parsed.netloc}"
    return "http://localhost:4100"


class Note:
    __slots__ = ("id", "kind", "text", "finding_id")

    def __init__(self, id: str, kind: str, text: str, finding_id: Optional[str]) -> None:
        self.id = id
        self.kind = kind
        self.text = text
        self.finding_id = finding_id

    def __repr__(self) -> str:  # pragma: no cover
        return f"Note({self.kind}: {self.text!r})"


class RootsClient:
    """One per process. Holds the SSE listener and a short-lived view of steering modes."""

    def __init__(self, url: Optional[str] = None, *, listen: bool = True) -> None:
        self.url = (url or _default_url()).rstrip("/")
        self.disabled = os.environ.get("NEATROOTS_STEER", "").lower() in {"0", "off", "false", "no"}
        self._mode = "unknown"
        # neatroots picks the mode per project, so it is remembered per run (trace): mode, checked at.
        self._modes: Dict[str, Tuple[str, float]] = {}
        self._steering_off_at = 0.0
        self._pending: Set[str] = set()
        self._sse_connected = False
        self._down_until = 0.0
        self._lock = threading.Lock()
        self._listener: Optional[threading.Thread] = None
        if listen and not self.disabled:
            self._start_listener()

    # ------------------------------------------------------------- transport

    def _post(self, path: str, body: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
        if self.disabled or time.monotonic() < self._down_until:
            return None
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.url + path, data=data, method="POST", headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            logger.debug("neatroots %s -> HTTP %s", path, exc.code)
            return None
        except Exception as exc:  # noqa: BLE001 - never break the agent
            logger.debug("neatroots unreachable at %s: %s", self.url, exc)
            # Back off so a stopped neatroots costs nothing per LLM call.
            self._down_until = time.monotonic() + 5.0
            return None

    # ------------------------------------------------------------- listener

    def _start_listener(self) -> None:
        t = threading.Thread(target=self._listen_forever, name="neatroots-steer-sse", daemon=True)
        self._listener = t
        t.start()

    def _listen_forever(self) -> None:
        backoff = 1.0
        while True:
            try:
                req = urllib.request.Request(self.url + "/api/steer/stream", headers={"accept": "text/event-stream"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    self._sse_connected = True
                    backoff = 1.0
                    event = None
                    for raw in resp:
                        line = raw.decode("utf-8").rstrip("\r\n")
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            self._on_event(event, line[5:].strip())
                        elif not line:
                            event = None
            except Exception as exc:  # noqa: BLE001
                logger.debug("neatroots stream closed: %s", exc)
            self._sse_connected = False
            time.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def _on_event(self, event: Optional[str], data: str) -> None:
        try:
            payload = json.loads(data)
        except ValueError:
            return
        with self._lock:
            if event == "note" and payload.get("trace_id"):
                self._pending.add(payload["trace_id"])
            elif event == "mode":
                self._modes = {t: (m, 0.0) for t, (m, _) in self._modes.items()}
                self._steering_off_at = 0.0
            elif event == "hello" and payload.get("enabled") is False:
                # Steering is off for every project.
                self._steering_off_at = time.monotonic()

    # ---------------------------------------------------------------- notes

    @property
    def mode(self) -> str:
        """The mode of the run claimed last. Use ``mode_for`` for a given run."""
        return self._mode

    def mode_for(self, trace_id: str) -> str:
        """This run's steering mode as last reported, or "unknown" for a run not seen before."""
        with self._lock:
            known = self._modes.get(trace_id)
        return known[0] if known else "unknown"

    def _should_claim(self, trace_id: str) -> bool:
        if self.disabled:
            return False
        now = time.monotonic()
        with self._lock:
            if trace_id in self._pending:
                return True
            if now - self._steering_off_at < 10.0:
                return False
            known = self._modes.get(trace_id)
            if known is None:
                # A run not seen before asks, whatever other projects' runs were told.
                return True
            mode, checked = known
            # A project with steering off is re-checked every 10 s rather than on every call.
            if mode == "off" and now - checked < 10.0:
                return False
            if mode in {"advisory", "self-check"} and self._sse_connected:
                # Nothing pending for this run; skip the round trip.
                return now - checked > 10.0
        return True

    def claim(self, trace_id: str, span_id: Optional[str] = None, *, gate_ms: Optional[int] = None) -> Optional[Note]:
        """Takes at most one pending note for this run. neatroots marks it delivered."""
        if not self._should_claim(trace_id):
            return None
        body: Dict[str, Any] = {"trace_id": trace_id}
        if span_id:
            body["span_id"] = span_id
        if gate_ms is not None:
            body["gate_ms"] = gate_ms
        timeout = 0.5 if gate_ms is None else gate_ms / 1000.0 + 0.5
        res = self._post("/api/steer/claim", body, timeout)
        if res is None:
            return None
        with self._lock:
            self._mode = res.get("mode") or "unknown"
            self._modes.pop(trace_id, None)
            self._modes[trace_id] = (self._mode, time.monotonic())
            if len(self._modes) > _MAX_MODES:
                self._modes.pop(next(iter(self._modes)))
            note = res.get("note")
            if not note:
                self._pending.discard(trace_id)
                return None
        return Note(note.get("id", ""), note.get("kind", "template"), note.get("text", ""), note.get("finding_id"))

    def check(self, trace_id: str, question: str, span_ids: Optional[list] = None, timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        body: Dict[str, Any] = {"trace_id": trace_id, "question": question}
        if span_ids:
            body["span_ids"] = span_ids
        return self._post("/api/steer/check", body, timeout)


_client: Optional[RootsClient] = None
_client_lock = threading.Lock()


def get_client() -> RootsClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = RootsClient()
        return _client


def configure(url: Optional[str] = None, *, listen: bool = True) -> RootsClient:
    """Points the hook at a neatroots app other than the default (NEATROOTS_URL or localhost:4100)."""
    global _client
    with _client_lock:
        _client = RootsClient(url, listen=listen)
        return _client
