# python-otel-genai-events

No Neatlogs SDK: OpenTelemetry's own OpenAI instrumentation (`opentelemetry-instrumentation-openai-v2`).
It records the prompt and reply as GenAI events, sent as OTLP log records to `/v1/logs`, instead of span
attributes. Spans and logs are exported separately, so the messages usually arrive after their span;
neatroots attaches them to the span when they come and shows the run's input and output.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

Message content is off by default in the GenAI instrumentations; the example sets
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, as you would in your own agent.
`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
