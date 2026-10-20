# python-anthropic

A research assistant on the Anthropic SDK (tool use), traced into neatroots.

    uv run agent.py "What's the weather in Paris?"

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your ANTHROPIC_API_KEY.

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
