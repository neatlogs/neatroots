# python-sub-agents

An orchestrator that delegates to two sub-agents (researcher, writer). In neatroots'
Overview each sub-agent is a card you can open as its own conversation.

    uv run agent.py "Write a short note on solar batteries"

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
