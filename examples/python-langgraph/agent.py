# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "langchain>=1.0", "langgraph>=1.0", "langchain-openai>=0.3"]
# ///
"""A LangChain / LangGraph tool-calling agent, traced into neatroots through the Neatlogs LangChain handler.

    uv run agent.py "Which of my orders shipped?"

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your OPENAI_API_KEY.
"""

import os
import sys

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402

neatlogs.init(workflow_name="example-langgraph-orders", flush_interval=0.5)

from langchain_core.tools import tool  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402
from langchain.agents import create_agent  # noqa: E402


@tool
def list_orders(customer: str) -> list[dict]:
    """List a customer's orders with their status."""
    return [{"order_id": "1001", "status": "shipped"}, {"order_id": "1002", "status": "processing"}]


@tool
def track_order(order_id: str) -> dict:
    """Track a single order by id."""
    return {"order_id": order_id, "carrier": "UPS", "eta": "2 days"}


model = ChatOpenAI(model=os.environ.get("MODEL", "gpt-4o-mini"), base_url=os.environ.get("OPENAI_BASE_URL"))
agent = create_agent(model, tools=[list_orders, track_order], system_prompt="You help customers with their orders. Use the tools.")

if __name__ == "__main__":
    question = " ".join(sys.argv[1:]) or "Which of my orders shipped?"
    result = agent.invoke({"messages": [("user", question)]}, config={"callbacks": [neatlogs.langchain_handler()]})
    print(result["messages"][-1].content)
    neatlogs.flush()
    neatlogs.shutdown()
