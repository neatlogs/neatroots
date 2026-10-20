"""neatroots-steer: get neatroots findings back into a running agent.

neatroots watches your agent's spans (sent by the public Neatlogs SDK) and, when a check
finds a problem mid-run, queues a short note. This hook adds that note to the agent's
next LLM call inside a <neatroots-guidance> block and records a neatroots.guidance span, so you can see
exactly what was added. It never edits tool calls or model output.

    import neatroots_steer
    client = neatroots_steer.wrap(OpenAI())            # or Anthropic(), AsyncOpenAI(), ...

    messages = neatroots_steer.apply(messages)         # or add the note yourself

    tools = [*my_tools, neatroots_steer.CHECK_MY_WORK_TOOL]   # let the agent ask neatroots
    neatroots_steer.check_my_work("Did I verify the order id before refunding?")

    question = neatroots_steer.replay_input("Is order 1001 ok?")   # replays from the app

Steering is opt-in per project in neatroots (neatroots steering advisory --project <name>).
"""

from __future__ import annotations

import asyncio
import copy
import functools
import inspect
import logging
import os
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._client import RootsClient, Note, configure, get_client

__all__ = [
    "wrap",
    "apply",
    "apply_anthropic",
    "guidance",
    "check_my_work",
    "handle_tool_call",
    "CHECK_MY_WORK_TOOL",
    "ANTHROPIC_CHECK_MY_WORK_TOOL",
    "NeatrootsHalt",
    "configure",
    "current_trace",
    "Note",
    "RootsClient",
    "replay_input",
    "replay_overrides",
]

__version__ = "0.2.9"

logger = logging.getLogger("neatroots_steer")

GUIDANCE_OPEN = "<neatroots-guidance>"
GUIDANCE_CLOSE = "</neatroots-guidance>"

# How long a flush before a claim or a self-check may hold up the agent's call.
_FLUSH_TIMEOUT_MS = 500


class NeatrootsHalt(RuntimeError):
    """Raised before an LLM call when one of your own neatroots rules says to stop the run."""


# ------------------------------------------------------------------ context


def current_trace() -> Tuple[Optional[str], Optional[str]]:
    """The (trace_id, span_id) of the active span, as hex, or (None, None).

    The Neatlogs SDK keeps its spans in a private context, so its public
    inject_trace_context() is asked first; plain OpenTelemetry context is the fallback.
    """
    try:
        import neatlogs  # type: ignore

        inject = getattr(neatlogs, "inject_trace_context", None)
        if callable(inject):
            carrier: Dict[str, str] = {}
            if inject(carrier):
                parts = carrier.get("traceparent", "").split("-")
                if len(parts) >= 3 and len(parts[1]) == 32:
                    return parts[1], parts[2]
    except Exception:  # noqa: BLE001
        pass
    try:
        from opentelemetry import trace  # type: ignore
    except ImportError:
        return None, None
    try:
        ctx = trace.get_current_span().get_span_context()
        if not ctx or not ctx.is_valid:
            return None, None
        return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001
        return None, None


_flushing: Optional[threading.Thread] = None
_flushing_lock = threading.Lock()


def _flush_sdk() -> None:
    """Pushes finished spans to neatroots now, so gate mode and self-checks see the latest step.

    Waits at most _FLUSH_TIMEOUT_MS. With its collector down, the SDK's flush takes seconds
    whatever timeout it is given, so it runs on its own thread and the agent doesn't wait for it.
    A flush that is still running isn't started again.
    """
    global _flushing
    with _flushing_lock:
        if _flushing is None or not _flushing.is_alive():
            _flushing = threading.Thread(target=_flush_now, name="neatroots-steer-flush", daemon=True)
            _flushing.start()
        flushing = _flushing
    flushing.join(_FLUSH_TIMEOUT_MS / 1000)


def _flush_now() -> None:
    try:
        import neatlogs  # type: ignore

        flush = getattr(neatlogs, "flush", None)
        if callable(flush):
            flush()
            return
    except Exception:  # noqa: BLE001
        pass
    try:
        from opentelemetry import trace  # type: ignore

        provider = trace.get_tracer_provider()
        force = getattr(provider, "force_flush", None)
        if callable(force):
            force(_FLUSH_TIMEOUT_MS)
    except Exception:  # noqa: BLE001
        pass


def _record(note: Note) -> None:
    """Leaves a visible record in the trace: a GUARDRAIL span named neatroots.guidance holding the note."""
    attrs = {
        "neatlogs.guardrail.name": "neatroots",
        "neatlogs.guardrail.triggered": True,
        "neatlogs.guardrail.action": "halt" if note.kind == "halt" else "guide",
        "input.value": note.text,
        "neatroots.note.id": note.id,
        "neatroots.note.kind": note.kind,
        "neatroots.finding.id": note.finding_id or "",
    }
    try:
        import neatlogs  # type: ignore

        trace_cm = getattr(neatlogs, "trace", None)
        if callable(trace_cm):
            with trace_cm("neatroots.guidance", kind="GUARDRAIL", **attrs):
                pass
            return
    except Exception:  # noqa: BLE001
        pass
    try:
        from opentelemetry import trace  # type: ignore

        trace.get_current_span().add_event("neatroots.guidance", {k: v for k, v in attrs.items() if v != ""})
    except Exception:  # noqa: BLE001
        pass


def guidance(trace_id: Optional[str] = None) -> Optional[Note]:
    """Claims the next pending note for the current run (at most one per LLM call).

    Raises NeatrootsHalt when the note is a stop from one of your own halt rules.
    """
    client = get_client()
    if client.paused():
        # The claim would be skipped anyway; skip the flush too, so a stopped neatroots (or
        # NEATROOTS_STEER=off) costs nothing per LLM call.
        return None
    span_id = None
    if trace_id is None:
        trace_id, span_id = current_trace()
    if not trace_id:
        return None
    gate_ms = None
    if client.mode_for(trace_id) in ("gate", "unknown"):
        # Push finished spans to neatroots first so it can check the latest step (and, the
        # first time, learn which project this run belongs to). neatroots only waits in gate mode.
        _flush_sdk()
        gate_ms = 300
    note = client.claim(trace_id, span_id, gate_ms=gate_ms)
    if note is None:
        return None
    _record(note)
    if note.kind == "halt":
        raise NeatrootsHalt(note.text)
    return note


def _block(note: Note) -> str:
    return f"{GUIDANCE_OPEN}\nNote from neatroots, a local checker watching this run: {note.text}\n{GUIDANCE_CLOSE}"


# --------------------------------------------------------------- injection


def _append_text(message: Dict[str, Any], text: str) -> Dict[str, Any]:
    m = dict(message)
    content = m.get("content")
    if isinstance(content, str):
        m["content"] = f"{content}\n\n{text}" if content else text
    elif isinstance(content, list):
        m["content"] = [*content, {"type": "text", "text": text}]
    else:
        m["content"] = text
    return m


def apply(messages: List[Dict[str, Any]], note: Optional[Note] = None) -> List[Dict[str, Any]]:
    """Returns OpenAI-style chat messages with the pending note added (a copy; the input is untouched)."""
    if note is None:
        note = guidance()
    if note is None or not messages:
        return messages
    out = list(messages)
    last = out[-1]
    role = last.get("role") if isinstance(last, dict) else getattr(last, "role", None)
    if role == "user" and isinstance(last, dict):
        out[-1] = _append_text(last, _block(note))
    else:
        out.append({"role": "user", "content": _block(note)})
    return out


def apply_anthropic(messages: List[Dict[str, Any]], note: Optional[Note] = None) -> List[Dict[str, Any]]:
    """Anthropic Messages API variant: user turns may hold tool_result blocks, so the note joins the last user turn."""
    if note is None:
        note = guidance()
    if note is None or not messages:
        return messages
    out = list(messages)
    last = out[-1]
    if isinstance(last, dict) and last.get("role") == "user":
        out[-1] = _append_text(last, _block(note))
    else:
        out.append({"role": "user", "content": [{"type": "text", "text": _block(note)}]})
    return out


def _apply_responses_input(value: Any, note: Note) -> Any:
    if isinstance(value, str):
        return f"{value}\n\n{_block(note)}"
    if isinstance(value, list):
        return [*value, {"role": "user", "content": _block(note)}]
    return value


# ------------------------------------------------------------------ replay


def replay_input(default: Any = None) -> Any:
    """The input to run with when neatroots replays this agent (NEATROOTS_REPLAY_INPUT), else ``default``.

    Use it where the agent reads its question, so "Replay with a different input" in the app works.
    """
    value = os.environ.get("NEATROOTS_REPLAY_INPUT")
    return value if value else default


def replay_overrides() -> Dict[str, str]:
    """The model and system prompt a neatroots replay asked for, if any. ``wrap`` applies them for you."""
    out: Dict[str, str] = {}
    if os.environ.get("NEATROOTS_REPLAY_MODEL"):
        out["model"] = os.environ["NEATROOTS_REPLAY_MODEL"]
    if os.environ.get("NEATROOTS_REPLAY_SYSTEM_PROMPT"):
        out["system"] = os.environ["NEATROOTS_REPLAY_SYSTEM_PROMPT"]
    return out


def _override_chat(kw: Dict[str, Any]) -> Dict[str, Any]:
    o = replay_overrides()
    if "model" in o:
        kw["model"] = o["model"]
    if "system" in o:
        msgs = [dict(m) if isinstance(m, dict) else m for m in (kw.get("messages") or [])]
        for m in msgs:
            if isinstance(m, dict) and m.get("role") in ("system", "developer"):
                m["content"] = o["system"]
                break
        else:
            msgs.insert(0, {"role": "system", "content": o["system"]})
        kw["messages"] = msgs
    return kw


def _override_responses(kw: Dict[str, Any]) -> Dict[str, Any]:
    o = replay_overrides()
    if "model" in o:
        kw["model"] = o["model"]
    if "system" in o:
        kw["instructions"] = o["system"]
    return kw


def _override_anthropic(kw: Dict[str, Any]) -> Dict[str, Any]:
    o = replay_overrides()
    if "model" in o:
        kw["model"] = o["model"]
    if "system" in o:
        kw["system"] = o["system"]
    return kw


# -------------------------------------------------------------------- wrap


def _wrap_method(
    owner: Any,
    name: str,
    transform: Callable[[Dict[str, Any], Note], Dict[str, Any]],
    override: Callable[[Dict[str, Any]], Dict[str, Any]] = lambda kw: kw,
) -> None:
    original = getattr(owner, name, None)
    if original is None or getattr(original, "__neatroots_wrapped__", False):
        return

    def prepare(kwargs: Dict[str, Any]) -> Dict[str, Any]:
        if replay_overrides():
            kwargs = override(dict(kwargs))
        try:
            note = guidance()
        except NeatrootsHalt:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("neatroots guidance failed", exc_info=True)
            return kwargs
        if note is None:
            return kwargs
        return transform(dict(kwargs), note)

    if inspect.iscoroutinefunction(original):

        @functools.wraps(original)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            prepared = await asyncio.to_thread(prepare, kwargs)
            return await original(*args, **prepared)

        async_wrapper.__neatroots_wrapped__ = True  # type: ignore[attr-defined]
        setattr(owner, name, async_wrapper)
    else:

        @functools.wraps(original)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return original(*args, **prepare(kwargs))

        wrapper.__neatroots_wrapped__ = True  # type: ignore[attr-defined]
        setattr(owner, name, wrapper)


def _wrap_factory(owner: Any, name: str) -> None:
    """Wrap a method that builds a new client (``with_options``, ``copy``) so the copy is wrapped too."""
    original = getattr(owner, name, None)
    if original is None or getattr(original, "__neatroots_wrapped__", False):
        return

    @functools.wraps(original)
    def factory(*args: Any, **kwargs: Any) -> Any:
        return wrap(original(*args, **kwargs))

    factory.__neatroots_wrapped__ = True  # type: ignore[attr-defined]
    setattr(owner, name, factory)


def wrap(client: Any) -> Any:
    """Adds neatroots guidance to an OpenAI or Anthropic client (sync or async), in place, and returns it.

    During a neatroots replay it also applies the model and system prompt the replay asked for.

    Covers chat.completions.create/parse and responses.create/parse (OpenAI) and
    messages.create/stream/parse (Anthropic), plus the client that ``with_options`` or ``copy``
    returns. OpenAI's ``stream()`` goes through ``create``, so it is not wrapped on its own.
    Wrap the client you pass to your agent; tracing by the Neatlogs SDK still records the call.
    """
    chat = getattr(client, "chat", None)
    completions = getattr(chat, "completions", None) if chat is not None else None
    recognized = False
    if completions is not None:
        recognized = True
        apply_chat = lambda kw, note: {**kw, "messages": apply(list(kw.get("messages") or []), note)}  # noqa: E731
        _wrap_method(completions, "create", apply_chat, _override_chat)
        _wrap_method(completions, "parse", apply_chat, _override_chat)
    responses = getattr(client, "responses", None)
    if responses is not None and hasattr(responses, "create"):
        recognized = True
        apply_responses = lambda kw, note: {**kw, "input": _apply_responses_input(kw.get("input"), note)}  # noqa: E731
        _wrap_method(responses, "create", apply_responses, _override_responses)
        _wrap_method(responses, "parse", apply_responses, _override_responses)
    messages = getattr(client, "messages", None)
    if messages is not None and hasattr(messages, "create") and completions is None:
        recognized = True
        apply_messages = lambda kw, note: {**kw, "messages": apply_anthropic(copy.copy(list(kw.get("messages") or [])), note)}  # noqa: E731
        _wrap_method(messages, "create", apply_messages, _override_anthropic)
        _wrap_method(messages, "stream", apply_messages, _override_anthropic)
        _wrap_method(messages, "parse", apply_messages, _override_anthropic)
    if recognized:
        _wrap_factory(client, "with_options")
        _wrap_factory(client, "copy")
    return client


# -------------------------------------------------------------- self-check

CHECK_MY_WORK_DESCRIPTION = (
    "Ask neatroots, a local checker that watches this run, a yes/no question about your own work so far "
    "(for example: 'Did I confirm the customer owns the order before refunding?'). "
    "Returns the probability that the answer is yes, judged from this run's recorded steps."
)

CHECK_MY_WORK_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "check_my_work",
        "description": CHECK_MY_WORK_DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {"question": {"type": "string", "description": "A yes/no question about this run so far."}},
            "required": ["question"],
        },
    },
}

ANTHROPIC_CHECK_MY_WORK_TOOL: Dict[str, Any] = {
    "name": "check_my_work",
    "description": CHECK_MY_WORK_DESCRIPTION,
    "input_schema": CHECK_MY_WORK_TOOL["function"]["parameters"],
}


def check_my_work(question: str, *, trace_id: Optional[str] = None, timeout: float = 30.0) -> Dict[str, Any]:
    """Asks neatroots a yes/no question about the current run. Returns probability_yes, answer and evidence span ids."""
    if trace_id is None:
        trace_id, _ = current_trace()
    if not trace_id:
        return {"answer": "unknown", "probability_yes": None, "reason": "no active trace; is the Neatlogs SDK initialized?"}
    client = get_client()
    res = None
    if not client.paused():
        _flush_sdk()
        res = client.check(trace_id, question, timeout=timeout)
    if res is None:
        return {"answer": "unknown", "probability_yes": None, "reason": "neatroots is not reachable"}
    return {
        "answer": res.get("answer", "unknown"),
        "probability_yes": res.get("probability"),
        "evidence_span_ids": res.get("evidence_span_ids", []),
        "reason": res.get("reason"),
    }


def handle_tool_call(name: str, arguments: Any) -> Optional[str]:
    """If `name` is check_my_work, runs it and returns the JSON result string to send back; else None."""
    if name != "check_my_work":
        return None
    import json

    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments or "{}")
        except ValueError:
            arguments = {"question": arguments}
    question = (arguments or {}).get("question") or ""
    return json.dumps(check_my_work(question))
