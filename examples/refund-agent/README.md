# refund-agent

A refund agent steered by neatroots: when a check fires mid-run, neatroots puts a short note into
the agent's next LLM call (through `neatroots_steer.wrap`). Watch the notes in the run's
"Notes to the agent" panel.

```bash
neatroots steering gate --project refund-agent
uv run agent.py "Refund order 4512"                          # with Ollama
LLM_BASE_URL=http://127.0.0.1:4199/v1 uv run agent.py        # with the scripted fake LLM (python3 fake_llm.py)
```

Gate mode pauses the agent when a check fires, so the note reaches its next call. With
`neatroots steering advisory` the agent keeps running, so give it time between steps for the
finding to land first: `STEP_DELAY=0.5 uv run agent.py ...`
