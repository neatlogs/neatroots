# python-pydanticai

A PydanticAI tool-calling agent traced by pydantic-ai's own OpenTelemetry instrumentation,
exporting OTLP to neatroots. No Neatlogs SDK; swap in any pydantic-ai model or provider the
same way.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317
    MODEL=mock-sloppy uv run agent.py "Please refund order 4512"   # claims success after a failed tool

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model
instead of the mock. The script declares Python 3.11+ (pydantic-ai 2.x needs it), so on a box whose
system python is older, `uv run` fetches a suitable interpreter itself; to pin one, pass
`uv run --python 3.12 agent.py`.

What lands in neatroots:

- `invoke_agent` → the run's agent span, `chat` → its LLM calls, `execute_tool` → its tool calls,
  with the model, per-call token counts, the conversation on each LLM span, and the session id.
- The failure scenario (`MODEL=mock-sloppy` with an unknown order) has the agent claim success
  after a tool reported `404`, so `soft-tool-failure` and the honesty checks have something to find.

Known gaps in what neatroots reads from pydantic-ai's spans today (none of them affect the checks):

- the run's input/output previews are empty: the root span carries the answer in `final_result`
  and the conversation in `pydantic_ai.all_messages`, and neatroots doesn't read either
- tools that were offered but not called don't show up: they're in `gen_ai.tool.definitions`
- the agent span's own token counts are empty: they're in `gen_ai.aggregated_usage.*`
