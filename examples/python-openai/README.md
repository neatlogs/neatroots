# python-openai

A support agent on the OpenAI SDK, traced by the Neatlogs SDK into neatroots.

    uv run agent.py "Please refund order 1001"
    MODEL=mock-sloppy uv run agent.py "Please refund order 4512"   # makes mistakes for neatroots to catch

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your OPENAI_API_KEY.

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
