# python-langgraph

A LangChain / LangGraph tool-calling agent, traced into neatroots through the Neatlogs LangChain handler.

    uv run agent.py "Which of my orders shipped?"

Runs against neatroots' mock LLM (start it with `neatroots mock-llm`); REAL_LLM=1 uses your OPENAI_API_KEY.

```bash
neatroots start && neatroots mock-llm   # in other terminals
uv run agent.py
```

`uv run` installs the dependencies listed at the top of agent.py. Set REAL_LLM=1 to use a real model instead of the mock.
