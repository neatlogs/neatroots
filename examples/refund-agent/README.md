# refund-agent

A refund agent steered by neatroots: when a check fires mid-run, neatroots puts a short note into
the agent's next LLM call (through `neatroots_steer.wrap`). Watch the notes in the run's
"Notes to the agent" panel.

```bash
neatroots steering advisory --project refund-agent
uv run agent.py "Refund order 4512"                          # with Ollama
LLM_BASE_URL=http://127.0.0.1:4199/v1 uv run agent.py        # with the scripted fake LLM (python3 fake_llm.py)
```
