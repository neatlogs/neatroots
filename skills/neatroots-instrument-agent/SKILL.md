---
name: neatroots-instrument-agent
description: Add the public Neatlogs SDK to an agent in this repo and point it at a local neatroots, so neatroots can check its runs. Use when the user wants neatroots or Neatlogs tracing on an agent, or neatroots shows no runs for it.
---

# Instrument an agent for neatroots

1. Detect the language and LLM client (OpenAI, Anthropic, LangChain, CrewAI, AI SDK, …).
2. Python: add `neatlogs` to the dependencies. Call `neatlogs.init(...)` once at startup, **before**
   importing instrumented libraries:
   ```python
   import neatlogs
   neatlogs.init(workflow_name="<agent-name>", instrumentations=["openai"], flush_interval=0.5)
   ```
   Decorate the request handler or main function with `@neatlogs.span(kind="WORKFLOW")` so each run is
   one trace. TypeScript: `await init({ workflowName, flushInterval: 0.5 })` (await it), and wrap the
   client with `wrapOpenAI`, `wrapAISDK`, etc. For other frameworks, the public `neatlogs/skills`
   repo has framework-specific guidance (`npx skills add neatlogs/skills`).
3. Point the SDK at neatroots without changing code paths that ship to production: add to `.env` (or the
   run script) `NEATLOGS_ENDPOINT=http://localhost:4100` and `NEATLOGS_API_KEY=neatroots-local`. Keep any
   real key the user already has; neatroots accepts and ignores it. `neatroots init --write-env` does this.
4. Verify: `python -m neatlogs doctor --probe` must pass against neatroots, then run the agent once and
   call the neatroots MCP tool `search_runs` (or open http://localhost:4100) to see the run.
5. Optional steering: `pip install neatroots-steer`, wrap the client with `neatroots_steer.wrap(...)`, and ask
   the user before enabling it (`neatroots steering advisory --project <agent-name>`), since it changes
   what the agent's LLM receives.
