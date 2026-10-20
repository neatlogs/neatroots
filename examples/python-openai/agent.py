# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai>=1.40"]
# ///
"""A support agent on the OpenAI SDK, traced by the Neatlogs SDK into neatroots.

    uv run agent.py "Please refund order 1001"
    MODEL=mock-sloppy uv run agent.py "Please refund order 4512"   # makes mistakes for neatroots to catch

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your OPENAI_API_KEY.
"""

import json
import os
import sys

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402
from neatlogs import span  # noqa: E402

neatlogs.init(workflow_name="example-openai-support", instrumentations=["openai"], flush_interval=0.5)

from openai import OpenAI  # noqa: E402

client = OpenAI()
MODEL = os.environ.get("MODEL", "gpt-4o-mini")
SYSTEM = "You are a support agent. Look up an order before refunding it, and never refund more than the order amount."
ORDERS = {"1001": {"order_id": "1001", "amount": 42.0, "status": "delivered"}, "2002": {"order_id": "2002", "amount": 30.0, "status": "shipped"}}
TOOLS = [
    {"type": "function", "function": {"name": "lookup_order", "description": "Look up an order by its id", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}}},
    {"type": "function", "function": {"name": "issue_refund", "description": "Refund an order", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}, "amount": {"type": "number"}}, "required": ["order_id", "amount"]}}},
]


@span(kind="TOOL", name="lookup_order")
def lookup_order(order_id: str):
    if order_id not in ORDERS:
        raise LookupError(f"404: order {order_id} not found")
    return ORDERS[order_id]


@span(kind="TOOL", name="issue_refund")
def issue_refund(order_id: str, amount: float):
    order = lookup_order(order_id)
    return {"refunded": min(amount, order["amount"]), "order_id": order_id}


def call(name: str, args: dict) -> str:
    try:
        return json.dumps({"lookup_order": lookup_order, "issue_refund": issue_refund}[name](**args))
    except Exception as exc:  # the agent sees the error, as a real one would
        return json.dumps({"error": str(exc)})


@span(kind="WORKFLOW", name="support")
def run(request: str) -> str:
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": request}]
    for _ in range(6):
        reply = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS).choices[0].message
        if not reply.tool_calls:
            return reply.content or ""
        messages.append({"role": "assistant", "content": reply.content, "tool_calls": [t.model_dump() for t in reply.tool_calls]})
        for t in reply.tool_calls:
            messages.append({"role": "tool", "tool_call_id": t.id, "content": call(t.function.name, json.loads(t.function.arguments or "{}"))})
    return "Stopped after too many steps."


if __name__ == "__main__":
    print(run(" ".join(sys.argv[1:]) or "Please refund order 1001"))
    neatlogs.flush()
    neatlogs.shutdown()
