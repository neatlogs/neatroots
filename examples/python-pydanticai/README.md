# python-pydanticai

A PydanticAI tool-calling agent traced by pydantic-ai's own OpenTelemetry instrumentation,
exporting OTLP to neatroots. No Neatlogs SDK; swap in any pydantic-ai model or provider the
same way.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317
    MODEL=mock-sloppy uv run agent.py "Please refund order 4512"   # claims success after a failed tool

```bash
neatroots start        # terminal 1, stays in the foreground
neatroots mock-llm     # terminal 2
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py, pinned to the versions this example
was tested with so the smoke test repeats. Set REAL_LLM=1 to use a real model
instead of the mock. The script declares Python 3.11+ (pydantic-ai 2.x needs it), so on a box whose
system python is older, `uv run` fetches a suitable interpreter itself; to pin one, pass
`uv run --python 3.12 agent.py`.

What lands in neatroots:

- `invoke_agent` → the run's agent span, `chat` → its LLM calls, `execute_tool` → its tool calls,
  with the model, per-call token counts, the conversation on each LLM span, and the session id.
- The run's input and output previews, the tools offered (called or not) and the agent span's own
  token counts come from `final_result`, `pydantic_ai.all_messages`, `gen_ai.tool.definitions` and
  `gen_ai.aggregated_usage.*`, which neatroots reads once #445 (the fix for #443) lands.
- The failure scenario (`MODEL=mock-sloppy` with an unknown order) has the agent claim success
  after a tool reported `404`, so `soft-tool-failure` and the honesty checks have something to find.
