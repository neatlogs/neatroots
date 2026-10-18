# /// script
# requires-python = ">=3.11"   # pydantic-ai 2.x needs 3.11+; uv downloads one if the system python is older
# dependencies = [
#   "pydantic-ai==2.57.0",
#   "opentelemetry-sdk==1.44.0",
#   "opentelemetry-exporter-otlp-proto-http==1.44.0",
#   "opentelemetry-exporter-otlp-proto-grpc==1.44.0",
# ]
# ///
"""A PydanticAI tool-calling agent traced by pydantic-ai's own OpenTelemetry instrumentation,
exporting OTLP to neatroots. No Neatlogs SDK: this is the plain-OpenTelemetry path, the way
pydantic-ai documents instrumentation.

    uv run --frozen agent.py                                 # OTLP/HTTP to localhost:4100
    OTLP_PROTOCOL=grpc uv run --frozen agent.py              # OTLP/gRPC to localhost:4317
    MODEL=mock-sloppy uv run --frozen agent.py "Please refund order 4512"   # claims success after a failed tool

Runs against neatroots' mock LLM by default (start it with `neatroots mock-llm`); REAL_LLM=1
uses OPENAI_API_KEY. Another neatroots? Set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or NEATLOGS_ENDPOINT
(HTTP) and NEATROOTS_GRPC (gRPC, host:port), as run-all.sh does.
"""

import json
import os
import sys
from urllib.parse import urlparse

if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

if os.environ.get("OTLP_PROTOCOL") == "grpc":
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.environ.get("NEATROOTS_GRPC") or "localhost:4317"
    # neatroots' gRPC server is on this machine and plaintext. Anywhere else the exporter decides,
    # so a bare host:port and https:// get TLS and authorization headers
    # (OTEL_EXPORTER_OTLP_TRACES_HEADERS) do not cross the network in the clear by default, while
    # an http:// endpoint still means plaintext was asked for by name.
    local = urlparse(endpoint if "://" in endpoint else "//" + endpoint).hostname in ("localhost", "127.0.0.1", "::1")
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True if local else None)
else:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    base = os.environ.get("NEATLOGS_ENDPOINT") or os.environ.get("NEATROOTS_URL") or "http://localhost:4100"
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or base.rstrip("/") + "/v1/traces"
    exporter = OTLPSpanExporter(endpoint=endpoint)

provider = TracerProvider(resource=Resource.create({"service.name": os.environ.get("PYDANTICAI_PROJECT", "example-pydanticai")}))
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

from pydantic_ai import Agent  # noqa: E402
from pydantic_ai.models.openai import OpenAIChatModel  # noqa: E402
from pydantic_ai.providers.openai import OpenAIProvider  # noqa: E402

# pydantic-ai's GenAI-semconv spans (invoke_agent / chat / execute_tool); neatroots reads them
# as the agent, LLM and tool spans of the run.
Agent.instrument_all(True)

MODEL = os.environ.get("MODEL", "gpt-4o-mini")
SYSTEM = "You are a support agent. Look up an order before refunding it, and never refund more than the order amount."
ORDERS = {"1001": {"order_id": "1001", "amount": 42.0, "status": "delivered"}, "2002": {"order_id": "2002", "amount": 30.0, "status": "shipped"}}

model = OpenAIChatModel(
    MODEL,
    provider=OpenAIProvider() if os.environ.get("REAL_LLM") == "1" else OpenAIProvider(base_url=os.environ["OPENAI_BASE_URL"], api_key="mock"),
)
agent = Agent(model, system_prompt=SYSTEM)


@agent.tool_plain
def lookup_order(order_id: str) -> str:
    """Look up an order by its id."""
    if order_id not in ORDERS:
        return json.dumps({"error": f"404: order {order_id} not found"})
    return json.dumps(ORDERS[order_id])


@agent.tool_plain
def issue_refund(order_id: str, amount: float) -> str:
    """Refund an order."""
    if order_id not in ORDERS:
        return json.dumps({"error": f"404: order {order_id} not found"})
    return json.dumps({"refunded": min(amount, ORDERS[order_id]["amount"]), "order_id": order_id})


if __name__ == "__main__":
    try:
        result = agent.run_sync(" ".join(sys.argv[1:]) or "Please refund order 1001")
        print(result.output)
    finally:
        provider.shutdown()  # also flush recorded failures before exiting
