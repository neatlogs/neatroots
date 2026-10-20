# Examples

Every example sends real runs to neatroots and runs without API keys: they use neatroots' mock
LLM by default (`neatroots mock-llm`, an OpenAI- and Anthropic-compatible stand-in). Set
`REAL_LLM=1` to use your own `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` instead.

```bash
neatroots start               # terminal 1
neatroots mock-llm            # terminal 2
cd examples/python-openai && uv run agent.py "Please refund order 1001"
```

Then open http://localhost:4100. `sh examples/run-all.sh` runs the automated agent examples
and the HTTP API example, and checks that each produced a run. Run `browser`, `import-files`,
`refund-agent`, and `samples` separately/by hand. With the installer, they are in `~/.neatroots/app/examples`.

| Example | Language | How it sends runs | Shows |
| --- | --- | --- | --- |
| [python-openai](python-openai) | Python | Neatlogs SDK, OpenAI auto-instrumentation | A tool-calling support agent. `MODEL=mock-sloppy` makes it claim success after a failed tool, for the checks to catch |
| [python-anthropic](python-anthropic) | Python | Neatlogs SDK, Anthropic auto-instrumentation | Tool use with Claude's API |
| [python-langgraph](python-langgraph) | Python | Neatlogs LangChain handler | A LangChain / LangGraph agent |
| [python-openai-agents](python-openai-agents) | Python | Neatlogs OpenAI Agents processor | A handoff between two agents: open each as a sub-agent in the Overview |
| [python-sub-agents](python-sub-agents) | Python | Neatlogs SDK `@span(kind="AGENT")` | An orchestrator with researcher and writer sub-agents |
| [python-sessions](python-sessions) | Python | Neatlogs SDK sessions | A three-turn chat: open any turn's Conversation tab |
| [python-replay](python-replay) | Python | Neatlogs SDK + `neatroots_steer` | An agent you can re-run from the app with a different input, model or system prompt |
| [python-opentelemetry](python-opentelemetry) | Python | Plain OpenTelemetry + OpenInference, OTLP/HTTP or gRPC | No Neatlogs SDK at all |
| [typescript-openai](typescript-openai) | TypeScript | Neatlogs TS SDK `wrapOpenAI` | The support agent on the OpenAI Node SDK |
| [typescript-vercel-ai](typescript-vercel-ai) | TypeScript | Neatlogs TS SDK `wrapAISDK` | A Vercel AI SDK agent with a tool |
| [http-api](http-api) | curl / Python stdlib | Neatlogs HTTP trace API (`POST /v1/trace`) | No SDK, no dependencies |
| [browser](browser) | HTML + JS | Neatlogs HTTP trace API from the browser | A chat widget sending traces |
| [import-files](import-files) | files | `neatroots import` or Add data → Import files | An OpenInference OTLP JSON trace and Neatlogs HTTP traces as JSONL |
| [refund-agent](refund-agent) | Python | Neatlogs SDK + steering hook | Steering: neatroots adds a note to the agent's next LLM call |
| [samples](samples) | Python | Neatlogs SDK | Eight scripted scenarios: six failures (loops, ignored errors, prompt injection, leaks, contradictions) and two healthy controls |
