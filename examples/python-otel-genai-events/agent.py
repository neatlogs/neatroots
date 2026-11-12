# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "openai>=1.40",
#   "opentelemetry-sdk>=1.30",
#   "opentelemetry-exporter-otlp-proto-http>=1.30",
#   "opentelemetry-exporter-otlp-proto-grpc>=1.30",
#   "opentelemetry-instrumentation-openai-v2>=2.1b0",
# ]
# ///
"""No Neatlogs SDK: OpenTelemetry's own OpenAI instrumentation, which sends the prompt and reply as
GenAI events (OTLP log records), not span attributes. Spans and logs are exported separately, so
the messages often reach neatroots after their span; neatroots attaches them to it either way.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317

Another neatroots? Set NEATLOGS_ENDPOINT (HTTP) or NEATROOTS_GRPC (gRPC, host:port), as run-all.sh does.
"""

import os

if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"
# Message content is off by default in the GenAI instrumentations: turn it on so the events carry it.
os.environ.setdefault("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true")

from opentelemetry import trace  # noqa: E402
from opentelemetry._events import set_event_logger_provider  # noqa: E402
from opentelemetry._logs import set_logger_provider  # noqa: E402
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor  # noqa: E402
from opentelemetry.sdk._events import EventLoggerProvider  # noqa: E402
from opentelemetry.sdk._logs import LoggerProvider  # noqa: E402
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

if os.environ.get("OTLP_PROTOCOL") == "grpc":
    from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

    endpoint = os.environ.get("NEATROOTS_GRPC") or "localhost:4317"
    spans, logs = OTLPSpanExporter(endpoint=endpoint, insecure=True), OTLPLogExporter(endpoint=endpoint, insecure=True)
else:
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    base = (os.environ.get("NEATLOGS_ENDPOINT") or os.environ.get("NEATROOTS_URL") or "http://localhost:4100").rstrip("/")
    spans, logs = OTLPSpanExporter(endpoint=base + "/v1/traces"), OTLPLogExporter(endpoint=base + "/v1/logs")

resource = Resource.create({"service.name": "example-otel-genai-events"})
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(BatchSpanProcessor(spans))
trace.set_tracer_provider(tracer_provider)
logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(logs))
set_logger_provider(logger_provider)
set_event_logger_provider(EventLoggerProvider(logger_provider))
OpenAIInstrumentor().instrument()

from openai import OpenAI  # noqa: E402

client = OpenAI()
tracer = trace.get_tracer("example")

if __name__ == "__main__":
    question = "Summarise OpenTelemetry in one line"
    with tracer.start_as_current_span("summarize"):
        reply = client.chat.completions.create(
            model=os.environ.get("MODEL", "gpt-4o-mini"),
            messages=[{"role": "system", "content": "Answer in one sentence."}, {"role": "user", "content": question}],
        )
    print(reply.choices[0].message.content or "")
    # Spans first, then the logs: their messages arrive after the span, as they often do in production.
    tracer_provider.shutdown()
    logger_provider.shutdown()
