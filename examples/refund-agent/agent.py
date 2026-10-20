# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai>=1.40", "neatroots-steer"]
#
# [tool.uv.sources]
# neatroots-steer = { path = "../../python/neatroots-steer", editable = true }
# ///
"""A small refund agent instrumented with the public Neatlogs SDK and steered by neatroots.

    uv run agent.py "Refund order 4512"                 # uses Ollama (gemma4 or $MODEL)
    LLM_BASE_URL=http://127.0.0.1:4199/v1 uv run agent.py   # the scripted fake LLM

Environment: NEATLOGS_ENDPOINT (default http://localhost:4100), MODEL, LLM_BASE_URL, STEP_DELAY.
"""

import json
import os
import sys
import time

import neatlogs
from neatlogs import span

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
neatlogs.init(workflow_name=os.environ.get("WORKFLOW", "refund-agent"), instrumentations=["openai"], flush_interval=0.2)

from openai import OpenAI  # noqa: E402  (import after neatlogs.init)

import neatroots_steer  # noqa: E402

client = neatroots_steer.wrap(OpenAI(base_url=os.environ.get("LLM_BASE_URL", "http://localhost:11434/v1"), api_key="local"))
MODEL = os.environ.get("MODEL", "gemma4:latest")
STEP_DELAY = float(os.environ.get("STEP_DELAY", "0"))

SYSTEM = (
    "You are a refund agent for an online shop. Use lookup_order to find an order before refunding it. "
    "Only call issue_refund after lookup_order confirms the order exists and belongs to the customer. "
    "Never refund more than the order amount."
)
TOOLS = [
    {"type": "function", "function": {"name": "lookup_order", "description": "Look up an order by id",
     "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}}},
    {"type": "function", "function": {"name": "issue_refund", "description": "Refund an order",
     "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}, "amount": {"type": "number"}}, "required": ["order_id", "amount"]}}},
    neatroots_steer.CHECK_MY_WORK_TOOL,
]
ORDERS = {"1001": {"order_id": "1001", "owner": "cust_9", "amount": 42.0}}


@span(kind="TOOL", name="lookup_order")
def lookup_order(order_id: str):
    if order_id not in ORDERS:
        raise LookupError(f"404: order {order_id} not found")
    return ORDERS[order_id]


@span(kind="TOOL", name="issue_refund")
def issue_refund(order_id: str, amount: float):
    return {"refunded": amount, "order_id": order_id}


def call_tool(name, args):
    handled = neatroots_steer.handle_tool_call(name, args)
    if handled is not None:
        return handled
    fn = {"lookup_order": lookup_order, "issue_refund": issue_refund}[name]
    try:
        return json.dumps(fn(**args))
    except Exception as exc:  # the agent sees tool errors as results
        return json.dumps({"error": str(exc)})


@span(kind="WORKFLOW", name="refund")
def run(request: str, max_steps: int = 8):
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": request}]
    for _ in range(max_steps):
        r = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS, max_tokens=300)
        m = r.choices[0].message
        if not m.tool_calls:
            return m.content
        messages.append({"role": "assistant", "content": m.content, "tool_calls": [tc.model_dump() for tc in m.tool_calls]})
        for tc in m.tool_calls:
            args = json.loads(tc.function.arguments or "{}")
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": call_tool(tc.function.name, args)})
        if STEP_DELAY:
            time.sleep(STEP_DELAY)
    return "Stopped after too many steps."


if __name__ == "__main__":
    try:
        print(run(sys.argv[1] if len(sys.argv) > 1 else "Please refund order 4512 for customer cust_9."))
    except neatroots_steer.NeatrootsHalt as exc:
        print(f"halted by neatroots: {exc}")
    finally:
        neatlogs.flush()
        neatlogs.shutdown()
