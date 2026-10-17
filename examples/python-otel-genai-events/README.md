# python-otel-genai-events

Plain OpenTelemetry traces and logs using the public GenAI message event conventions.
The prompt is a span event; system instructions and the answer are correlated log records.
The logs flush after the span to demonstrate late message arrival in Conversation and search.

Start `neatroots start` and `neatroots mock-llm` in separate terminals, then run:

```bash
uv run agent.py
```

No API keys are needed. Set `REAL_LLM=1` and your OpenAI credentials to use a real provider.
`MODEL`, `MOCK_LLM_URL`, and `NEATLOGS_ENDPOINT` (or `NEATROOTS_URL`) override the defaults.
The script prints the answer and the run's chat API URL.

neatroots also accepts `gen_ai.client.inference.operation.details` logs or span events,
with structured or JSON `gen_ai.input.messages` / `gen_ai.output.messages` attributes,
and the older `gen_ai.content.prompt` / `gen_ai.content.completion` events. Existing
span attributes take precedence independently for input and output. Raw stored spans
and cloud forwarding remain unchanged; log content is used only in derived views.

Public format references: [message events (v1.34)](https://github.com/open-telemetry/semantic-conventions/blob/v1.34.0/docs/gen-ai/gen-ai-events.md)
and [operation details (v1.37)](https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-events.md).
