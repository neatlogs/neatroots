# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "openai>=1.40",
#   "opentelemetry-sdk>=1.27",
#   "opentelemetry-exporter-otlp-proto-http>=1.27",
#   "opentelemetry-exporter-otlp-proto-grpc>=1.27",
#   "openinference-instrumentation-openai>=0.1",
# ]
# ///
"""No Neatlogs SDK: plain OpenTelemetry with the OpenInference OpenAI instrumentor, exporting
OTLP to neatroots. Swap in any OpenInference or OpenLLMetry instrumentor the same way.

    uv run agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run agent.py              # OTLP/gRPC to localhost:4317

Another neatroots? Set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or NEATLOGS_ENDPOINT (HTTP) and
NEATROOTS_GRPC (gRPC, host:port), as run-all.sh does.
"""

import os

if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

from openinference.instrumentation.openai import OpenAIInstrumentor  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

if os.environ.get("OTLP_PROTOCOL") == "grpc":
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.environ.get("NEATROOTS_GRPC") or "localhost:4317"
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
else:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    base = os.environ.get("NEATLOGS_ENDPOINT") or os.environ.get("NEATROOTS_URL") or "http://localhost:4100"
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or base.rstrip("/") + "/v1/traces"
    exporter = OTLPSpanExporter(endpoint=endpoint)

provider = TracerProvider(resource=Resource.create({"service.name": "example-opentelemetry"}))
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)
OpenAIInstrumentor().instrument(tracer_provider=provider)

from openai import OpenAI  # noqa: E402

tracer = trace.get_tracer("example")
client = OpenAI()

if __name__ == "__main__":
    with tracer.start_as_current_span("summarize", attributes={"openinference.span.kind": "CHAIN", "input.value": "Summarise OpenTelemetry in one line"}) as span:
        reply = client.chat.completions.create(model=os.environ.get("MODEL", "gpt-4o-mini"), messages=[{"role": "user", "content": "Summarise OpenTelemetry in one line"}])
        text = reply.choices[0].message.content or ""
        span.set_attribute("output.value", text)
    print(text)
    provider.shutdown()
