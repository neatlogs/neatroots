# neatroots-steer

The steering hook for [neatroots](https://github.com/neatlogs/neatroots). When neatroots finds a
problem in a run that is still going, this hook adds neatroots' short note to the agent's next LLM
call inside a `<neatroots-guidance>` block and records a `neatroots.guidance` span event. It never edits
tool calls or model output, and it does nothing when neatroots is not running.

```bash
pip install neatroots-steer
```

```python
import neatlogs, neatroots_steer
neatlogs.init(workflow_name="refund-agent", instrumentations=["openai"], flush_interval=0.5)
from openai import OpenAI

client = neatroots_steer.wrap(OpenAI())        # OpenAI, AsyncOpenAI, Anthropic, AsyncAnthropic
```

Turn steering on for the project in neatroots (it is off by default):

```bash
neatroots steering advisory --project refund-agent   # or gate, self-check, off
```

Other ways in:

- `neatroots_steer.apply(messages)` adds the pending note to OpenAI-style messages yourself;
  `apply_anthropic(messages)` for the Anthropic Messages API.
- `neatroots_steer.guidance()` returns the pending note (or `None`) for any framework.
- `CHECK_MY_WORK_TOOL` / `ANTHROPIC_CHECK_MY_WORK_TOOL` give the agent a tool to ask neatroots a
  yes/no question about its own run; answer tool calls with `neatroots_steer.handle_tool_call(name, args)`
  or call `neatroots_steer.check_my_work(question)`.
- `NeatrootsHalt` is raised before an LLM call when one of your own halt rules fires.

Configuration: `NEATROOTS_URL` (default: the local `NEATLOGS_ENDPOINT`, else `http://localhost:4100`),
`NEATROOTS_STEER=off` to disable. AnyIO offloads async steering preparation on the active asyncio
or Trio backend, preserving trace context. Cancelling during preparation prevents provider execution while
already running synchronous preparation finishes in its thread. It reads the current trace from
OpenTelemetry when `opentelemetry-api` is installed (the Neatlogs SDK installs it).
