# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "anthropic>=0.40"]
# ///
"""A research assistant on the Anthropic SDK (tool use), traced into neatroots.

    uv run agent.py "What's the weather in Paris?"

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your ANTHROPIC_API_KEY.
"""

import json
import os
import sys

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["ANTHROPIC_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110")
    os.environ["ANTHROPIC_API_KEY"] = "mock"

import neatlogs  # noqa: E402
from neatlogs import span  # noqa: E402

neatlogs.init(workflow_name="example-anthropic-assistant", instrumentations=["anthropic"], flush_interval=0.5)

import anthropic  # noqa: E402

client = anthropic.Anthropic()
MODEL = os.environ.get("MODEL", "claude-haiku-4-5")
TOOLS = [
    {"name": "get_weather", "description": "Current weather for a city", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
    {"name": "search_docs", "description": "Search the product docs", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
]


@span(kind="TOOL", name="get_weather")
def get_weather(city: str):
    return {"city": city, "forecast": "sunny", "temp_c": 21}


@span(kind="TOOL", name="search_docs")
def search_docs(query: str):
    return [{"title": "Getting started", "snippet": f"How to {query}"}]


@span(kind="AGENT", name="assistant")
def run(question: str) -> str:
    messages = [{"role": "user", "content": question}]
    for _ in range(5):
        msg = client.messages.create(model=MODEL, max_tokens=512, tools=TOOLS, messages=messages)
        uses = [b for b in msg.content if b.type == "tool_use"]
        if not uses:
            return "".join(b.text for b in msg.content if b.type == "text")
        messages.append({"role": "assistant", "content": msg.content})
        results = []
        for u in uses:
            out = {"get_weather": get_weather, "search_docs": search_docs}[u.name](**u.input)
            results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(out)})
        messages.append({"role": "user", "content": results})
    return "Stopped after too many steps."


if __name__ == "__main__":
    print(run(" ".join(sys.argv[1:]) or "What's the weather in Paris?"))
    neatlogs.flush()
    neatlogs.shutdown()
