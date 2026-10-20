# python-sessions

A multi-turn chat: every turn is a run, all in one session. Open any turn in neatroots and
look at the Conversation tab.

    uv run agent.py

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
