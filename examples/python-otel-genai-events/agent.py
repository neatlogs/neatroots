# /// script
# requires-python = ">=3.10"
# dependencies = ["openai>=1.40", "opentelemetry-sdk>=1.39", "opentelemetry-exporter-otlp-proto-http>=1.39"]
# ///
"""Public OTel GenAI events, including logs exported after the span. No Neatlogs SDK."""
import os

from openai import OpenAI
from opentelemetry import trace
from opentelemetry._logs import get_logger, set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

endpoint = os.environ.get("NEATLOGS_ENDPOINT") or os.environ.get("NEATROOTS_URL") or "http://localhost:4100"
resource = Resource.create({"service.name": "example-otel-genai-events"})
traces = TracerProvider(resource=resource)
traces.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint.rstrip("/") + "/v1/traces")))
trace.set_tracer_provider(traces)
logs = LoggerProvider(resource=resource)
logs.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint.rstrip("/") + "/v1/logs")))
set_logger_provider(logs)
logger = get_logger("example-otel-genai-events")
tracer = trace.get_tracer("example-otel-genai-events")
real = os.environ.get("REAL_LLM") == "1"
client = OpenAI() if real else OpenAI(base_url=os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1"), api_key="mock")

if __name__ == "__main__":
    try:
        with tracer.start_as_current_span("chat", attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": os.environ.get("MODEL", "gpt-4o-mini")}) as call:
            logger.emit(event_name="gen_ai.system.message", body={"content": "You are terse."})
            call.add_event("gen_ai.user.message", {"content": "What is 2+2?"})
            response = client.chat.completions.create(model=os.environ.get("MODEL", "gpt-4o-mini"), messages=[{"role": "system", "content": "You are terse."}, {"role": "user", "content": "What is 2+2?"}])
            answer = response.choices[0].message.content or ""
            logger.emit(event_name="gen_ai.choice", body={"index": 0, "finish_reason": "stop", "message": {"content": answer}})
            trace_id = f"{call.get_span_context().trace_id:032x}"
        # The span is already exported; queued logs exercise the late-arrival path.
        logs.force_flush()
        print(answer)
        print(f"{endpoint.rstrip('/')}/api/runs/{trace_id}/chat")
    finally:
        logs.shutdown()
        traces.shutdown()
