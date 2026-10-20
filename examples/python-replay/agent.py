# /// script
# requires-python = ">=3.10"
# dependencies = ["neatlogs>=1.4.25", "openai>=1.40", "neatroots-steer"]
#
# [tool.uv.sources]
# neatroots-steer = { path = "../../python/neatroots-steer", editable = true }
# ///
"""An agent ready for replays from the neatroots app: it reads its question through
neatroots_steer.replay_input(), and the wrapped client applies a replay's model and system prompt.

    uv run agent.py                                             # one run
    neatroots rerun add example-replay "uv run agent.py"        # then use Replay on any of its runs
"""

import os

os.environ.setdefault("NEATLOGS_ENDPOINT", "http://localhost:4100")
os.environ.setdefault("NEATLOGS_API_KEY", "neatroots-local")
if os.environ.get("REAL_LLM") != "1":  # neatroots' mock LLM (neatroots mock-llm); REAL_LLM=1 uses your own key
    os.environ["OPENAI_BASE_URL"] = os.environ.get("MOCK_LLM_URL", "http://127.0.0.1:4110/v1")
    os.environ["OPENAI_API_KEY"] = "mock"

import neatlogs  # noqa: E402
from neatlogs import span  # noqa: E402

neatlogs.init(workflow_name="example-replay", instrumentations=["openai"], flush_interval=0.5)

import neatroots_steer  # noqa: E402
from openai import OpenAI  # noqa: E402

client = neatroots_steer.wrap(OpenAI())


@span(kind="WORKFLOW", name="answer")
def answer(question: str) -> str:
    messages = [{"role": "system", "content": "Answer in one sentence."}, {"role": "user", "content": question}]
    return client.chat.completions.create(model=os.environ.get("MODEL", "gpt-4o-mini"), messages=messages).choices[0].message.content or ""


if __name__ == "__main__":
    print(answer(neatroots_steer.replay_input("What does a retrieval-augmented agent do?")))
    neatlogs.flush()
    neatlogs.shutdown()
