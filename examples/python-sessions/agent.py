# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai>=1.40"]
# ///
"""A multi-turn chat: every turn is a run, all in one session. Open any turn in neatroots and
look at the Conversation tab.

    uv run agent.py
"""

import os
import uuid

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402
from neatlogs import span  # noqa: E402

neatlogs.init(workflow_name="example-chat-session", instrumentations=["openai"], flush_interval=0.5)

from openai import OpenAI  # noqa: E402

client = OpenAI()
TURNS = ["Hi! I'm planning a trip to Lisbon.", "What should I pack for October?", "And one restaurant you'd recommend?"]


@span(kind="WORKFLOW", name="chat-turn")
def turn(history: list[dict], text: str) -> str:
    history.append({"role": "user", "content": text})
    reply = client.chat.completions.create(model=os.environ.get("MODEL", "gpt-4o-mini"), messages=history).choices[0].message.content or ""
    history.append({"role": "assistant", "content": reply})
    return reply


if __name__ == "__main__":
    session = f"trip-{uuid.uuid4().hex[:6]}"
    history = [{"role": "system", "content": "You are a friendly travel assistant."}]
    for text in TURNS:
        with neatlogs.identify(session_id=session):
            print(f"> {text}\n{turn(history, text)}\n")
    print(f"session: {session}")
    neatlogs.flush()
    neatlogs.shutdown()
