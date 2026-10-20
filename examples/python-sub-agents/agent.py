# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai>=1.40"]
# ///
"""An orchestrator that delegates to two sub-agents (researcher, writer). In neatroots'
Overview each sub-agent is a card you can open as its own conversation.

    uv run agent.py "Write a short note on solar batteries"
"""

import os
import sys

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402
from neatlogs import span  # noqa: E402

neatlogs.init(workflow_name="example-sub-agents", instrumentations=["openai"], flush_interval=0.5)

from openai import OpenAI  # noqa: E402

client = OpenAI()
MODEL = os.environ.get("MODEL", "gpt-4o-mini")


def ask(system: str, user: str) -> str:
    return client.chat.completions.create(model=MODEL, messages=[{"role": "system", "content": system}, {"role": "user", "content": user}]).choices[0].message.content or ""


@span(kind="TOOL", name="web_search")
def web_search(query: str) -> list[dict]:
    return [{"title": f"{query}: an overview", "url": "https://example.com/1"}, {"title": f"{query} in 2026", "url": "https://example.com/2"}]


@span(kind="AGENT", name="researcher")
def researcher(topic: str) -> str:
    results = web_search(topic)
    return ask("You summarise search results into facts.", f"Topic: {topic}\nResults: {results}")


@span(kind="AGENT", name="writer")
def writer(topic: str, facts: str) -> str:
    return ask("You write short, clear notes.", f"Write a note on {topic} using these facts:\n{facts}")


@span(kind="AGENT", name="orchestrator")
def orchestrate(task: str) -> str:
    facts = researcher(task)
    return writer(task, facts)


if __name__ == "__main__":
    print(orchestrate(" ".join(sys.argv[1:]) or "Write a short note on solar batteries"))
    neatlogs.flush()
    neatlogs.shutdown()
