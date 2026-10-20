# python-opentelemetry

No Neatlogs SDK: plain OpenTelemetry with the OpenInference OpenAI instrumentor, exporting
OTLP to neatroots. Swap in any OpenInference or OpenLLMetry instrumentor the same way.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
