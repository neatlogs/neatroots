# neatroots: the use case

neatroots checks your AI agent while you build it, on your own machine. It tells you what went wrong, tells your coding agent too, lets you replay a run with your changes, and can nudge the agent mid-run.

The name is the idea: an agent's roots are on the developer's laptop. neatroots is where it starts; Neatlogs is where it goes once it grows up, with the same SDK.

## Who it is for

- Developers building agents that call tools (support, refunds, research, ops) and who use Claude Code, Cursor or Codex to write them.
- Teams that cannot send dev traces to a hosted service because they hold customer data or keys.
- Neatlogs SDK users who want a free, local first step.
- Anyone already sending OpenTelemetry who wants checks and replays on their own runs without changing instrumentation.

## Four jobs it does better than the alternatives

1. **Catch silent failures that no test asserts.** The agent ignored a tool error and said "done". It followed an instruction hidden in a tool result. It stopped early. Rules in code catch loops, repeated calls and leaked keys on every span. A decision model answers the harder yes/no questions with a probability.
2. **Give your coding agent evidence, not a guess.** Over MCP, Claude Code reads the run, the findings and the explanation, fixes the bug, and adds a check so it is caught next time. Trace viewers give it raw spans. neatroots gives it the diagnosis.
3. **Try the fix before you write it.** Replay one LLM call with an edited message, another model or a new system prompt, with no agent running. Or re-run the whole agent from the app with a new input, and compare the two runs.
4. **Put a finding back into the live run.** Opt in per project. neatroots adds a short note to the agent's next LLM call, holds a call up to 300 ms while checks finish, or gives the agent a `check_my_work` tool. Guardrail products block. Trace tools only report.

## A day in the life (an example, not a measured case)

Maya builds a refund agent with the Neatlogs SDK. She points it at `localhost:4100`. No code change.

- **10:00.** She runs the agent on 20 sample tickets. neatroots flags one run: the payments tool returned an error, and the agent told the customer the refund was issued. A second run followed an instruction planted in a tool result.
- **10:05.** She replays the failing LLM call with a stricter system prompt. The replay says the refund failed, so the prompt is the fix.
- **10:10.** She tells Claude Code: "Fix what neatroots found in the last run." Claude reads the run and explanation over MCP, changes the error handling and the prompt, adds a check, replays the run and compares it with the original. The check passes.
- **14:00.** Steering is on. The agent starts repeating the same lookup. neatroots adds a note to its next call: "You have run this lookup three times with the same result." The agent changes approach.
- **17:00.** Before the pull request, she sends one clean run to Neatlogs Cloud, redacted first. Nothing else left her machine.

## Why not just let Claude do it?

Sometimes you should. neatroots can use Claude as its model, and for a solo developer with non-sensitive data that is often the best judge. Local still matters for five reasons.

- **Cost.** Judging every span of every run with a frontier model adds up. Rules are free. A small local model is cheap.
- **Speed.** A hold of 300 ms cannot wait on a hosted call that takes seconds.
- **Privacy.** Dev traces hold prompts, customer data and secrets. Local means no new data-handling decision.
- **Determinism.** Loops and leaked keys are code, not opinion.
- **Always on.** CI and overnight runs have no chat session to ask.

Claude Code cannot see your agent's runs on its own. neatroots is how it gets them.

Where the skeptic is right: a small model is not better than Claude at judging. neatroots' own trust test measures agreement with a local LLM, not truth. Treat its probabilities as unproven until checked against human labels. neatroots' answer is a cascade: rules first, a small decision model next, and the LLM only where a question or an investigation needs it. That LLM can be Claude if you turn it on (`neatroots llm use anthropic`).

## What neatroots is not

- **Not a production monitor.** It is built for development and pre-release. Production needs a hosted tool such as Neatlogs Cloud.
- **Not a security product.** It flags leaks and injection. It does not replace a guardrail gateway.
- **Not a proof system.** It gives probabilities, not guarantees. For formal guarantees on reasoning, see Microsoft's interwhen (research code).
- **Not the only local trace viewer.** Raindrop Workshop and others also hand traces to coding agents. neatroots' difference is checks, steering and findings.
- **Not finished.** The local decision model is still earning trust, and the probabilities are not yet calibrated against human labels. The [tester guide](tester-guide.md) is how we are finding out where it falls short.
