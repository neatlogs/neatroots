# python-openai-agents

OpenAI Agents SDK: a triage agent that hands off to a refunds agent. Each agent becomes a
sub-agent you can open in neatroots' Overview.

    uv run agent.py "I want a refund for order 1001"

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
