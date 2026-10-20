# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai-agents>=0.2"]
# ///
"""OpenAI Agents SDK: a triage agent that hands off to a refunds agent. Each agent becomes a
sub-agent you can open in neatroots' Overview.

    uv run agent.py "I want a refund for order 1001"
"""

import asyncio
import os
import sys

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402

neatlogs.init(workflow_name="example-openai-agents", flush_interval=0.5)

from agents import Agent, Runner, function_tool, set_default_openai_api, set_trace_processors  # noqa: E402

# The mock LLM speaks Chat Completions; real OpenAI works either way.
set_default_openai_api("chat_completions")
# Replace the SDK's default exporter (which sends to OpenAI) with the Neatlogs one, so traces stay local.
set_trace_processors([neatlogs.openai_agents_processor()])
MODEL = os.environ.get("MODEL", "gpt-4o-mini")


@function_tool
def lookup_order(order_id: str) -> dict:
    """Look up an order by id."""
    return {"order_id": order_id, "amount": 42.0, "status": "delivered"}


@function_tool
def issue_refund(order_id: str, amount: float) -> dict:
    """Refund an order."""
    return {"refunded": amount, "order_id": order_id}


refunds = Agent(name="Refunds agent", model=MODEL, instructions="Look up the order, then refund it.", tools=[lookup_order, issue_refund])
triage = Agent(name="Triage agent", model=MODEL, instructions="Route refund requests to the refunds agent.", handoffs=[refunds])

if __name__ == "__main__":
    result = asyncio.run(Runner.run(triage, " ".join(sys.argv[1:]) or "I want a refund for order 1001"))
    print(result.final_output)
    neatlogs.flush()
    neatlogs.shutdown()
