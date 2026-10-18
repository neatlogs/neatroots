# python-pydanticai

A PydanticAI tool-calling agent traced by pydantic-ai's own OpenTelemetry instrumentation,
exporting OTLP to neatroots. No Neatlogs SDK; swap in any pydantic-ai model or provider the
same way.

    uv run --frozen agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run --frozen agent.py              # OTLP/gRPC to localhost:4317
    MODEL=mock-sloppy uv run --frozen agent.py "Please refund order 4512"   # claims success after a failed tool

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run --frozen agent.py
```

`uv run --frozen` uses the committed `agent.py.lock` with exact direct dependency versions.
Do not regenerate the lock just to run the example; use `uv lock --script agent.py` only when intentionally updating and revalidating dependencies. Set REAL_LLM=1 to use a real model
instead of the mock. The script declares Python 3.11+ (pydantic-ai 2.x needs it), so on a box whose
system python is older, `uv run` fetches a suitable interpreter itself; to pin one, pass
`uv run --frozen --python 3.12 agent.py`.

What lands in neatroots:

- `invoke_agent` → the run's agent span, `chat` → its LLM calls, `execute_tool` → its tool calls,
  with the model, per-call token counts, the conversation on each LLM span, and the session id.
- The run's input and output previews, the tools offered (called or not) and the agent span's own
  token counts come from `final_result`, `pydantic_ai.all_messages`, `gen_ai.tool.definitions` and
  `gen_ai.aggregated_usage.*`, which neatroots reads as of #470.
- The failure scenario (`MODEL=mock-sloppy` with an unknown order) has the agent claim success
  after a tool reported `404`, so `soft-tool-failure` and the honesty checks have something to find.


## Repeatable local smoke

From the repository root, install/build neatroots, then run:

```sh
pnpm --filter @neatlogs/neatroots exec tsx ../../examples/python-pydanticai/smoke.mjs
```

This starts only isolated loopback mock/collector services and runs the real pinned
PydanticAI agent in clean and unknown-order failure scenarios over OTLP/HTTP and
OTLP/gRPC. It verifies the emitted agent/LLM/tool parent relationships, model and
LLM/tool inputs/outputs, model-backed `done` coverage with all questions answered, and the failure's `soft-tool-failure`
evidence. An ambient OpenAI URL points to a local trap that must receive no request.
Set `SMOKE_OUTPUT=/absolute/path/receipt.json` to retain the exact emitted span
attributes and resulting findings. No user runs or hosted provider are used.

Mock mode always selects `MOCK_LLM_URL` (default `http://127.0.0.1:4110/v1`) and a
mock key, ignoring ambient `OPENAI_BASE_URL` and `OPENAI_API_KEY`. An explicitly
supplied `MOCK_LLM_URL` is intentional configuration: keep it on your local mock.
Only `REAL_LLM=1` selects the usual real-provider environment. The smoke never
uses that mode. `PYDANTICAI_PROJECT` can isolate the resource service name for
verification; the default remains `example-pydanticai`.

Run configuration/cleanup regressions without installing model dependencies:

```sh
python -m unittest discover -s examples/python-pydanticai -p 'test_*.py'
```

PR442's base supports the hierarchy and LLM/tool evidence. Root previews,
offered-but-uncalled tools and aggregate agent tokens require the separate PR470
semantic change. The primary smoke does not pretend those reads exist on the base;
inspect the retained raw attributes when validating that separate dependency.
The exporter is shut down even when `run_sync` raises, so already-recorded spans
are flushed before the exception leaves the process.


The pinned smoke records `invoke_agent agent` as the sole root, two `chat` LLM
children and one `execute_tool issue_refund` child, all sharing one trace. The clean
run has no `soft-tool-failure`; the unknown-order run has one with the tool span as
evidence. It waits for the real engine end pass and zero pending work, not a fixed
sleep or only a run count. The CLI closes its owned servers before exiting; no
production lifecycle code is changed.

Direct pins are PydanticAI 2.57.0 and OpenTelemetry SDK/HTTP/gRPC exporters 1.44.0.
The committed script lock pins their transitive resolution too. For an already
provisioned isolated environment, set `SMOKE_PYTHON` to its Python executable; it
must have been installed from this exact lock. Otherwise the smoke uses
`uv run --frozen`. `SMOKE_OUTPUT` includes whether owned cleanup completed.

Smoke receipts record `SMOKE_PYTHON` as an explicit interpreter override when supplied; that bypasses uv during execution. The separate frozen lock export and hash-checked environment installation are the reproducibility proof, not the override itself. Failed assertions or cleanup return nonzero within the fixture deadlines, even if library handles remain.
