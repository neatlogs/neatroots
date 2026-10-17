# Replay and fork

A replay runs part or all of a recorded run again with something changed: a message, the model, the
system prompt, or the input. It answers "would this have gone better if…" before you change code.

Every replay is a new run, linked to the run it came from, and checked like any other run, so its
problems show up the same way. The original run lists its replays, and the
replay links back. `compare_runs` (MCP) puts the two side by side.

## One LLM call

Needs no agent and no setup, only an LLM configured in neatroots (local or hosted).

- **Replay** on a run → **One LLM call**, or **Replay this call** on an LLM span.
- Change the model, the system prompt, or edit any message, then **Replay LLM call**.
- From the Overview: hover a user message, **Edit and fork**, then **Re-run this LLM call**.
- From the terminal: `neatroots replay <trace-id> --span <span-id> --model gpt-4o-mini`.
- From a coding agent: the `replay` tool with `span_id`.

neatroots re-sends the call's recorded messages, with your changes, through its own LLM and stores
the request and answer as a new run (with `neatroots.replay.of_trace` and `neatroots.replay.of_span`
pointing at the original). The call goes without tool definitions, so the model answers in text;
earlier tool calls and results in the conversation are kept, as text.

## The whole agent

Runs your agent again, so tool calls, sub-agents and every later step happen for real. neatroots
needs to know how to start it, once per project:

```bash
neatroots rerun add refund-agent "uv run agent.py" --cwd ~/code/refund-agent   # a command
neatroots rerun add web-agent --url http://localhost:3000/replay               # or an HTTP endpoint
neatroots rerun list
```

Or **Settings → Projects → Set up** next to the project. Then:

- **Replay** on a run → **Re-run the agent**, with a new input, model or system prompt (each optional).
- In the Overview, **Edit and fork** a user message → **Re-run the agent**.
- `neatroots replay <trace-id> --input "Refund order 2002" --model gpt-4o-mini --system "…"`.
- The `replay` or `rerun` MCP tools.

### What the agent receives

With a command, neatroots runs it in its folder with these environment variables:

| Variable | Value |
| --- | --- |
| `NEATROOTS_REPLAY_INPUT` | The input to run with (the original input unless you changed it) |
| `NEATROOTS_REPLAY_MODEL` | The model to use, if you set one |
| `NEATROOTS_REPLAY_SYSTEM_PROMPT` | The system prompt to use, if you set one |
| `NEATROOTS_REPLAY_ID`, `NEATROOTS_REPLAY_OF` | The replay's id and the run it replays |
| `NEATLOGS_ENDPOINT`, `NEATLOGS_API_KEY` | Pointed at this neatroots |
| `OTEL_RESOURCE_ATTRIBUTES` | Adds `neatroots.replay.id` and `neatroots.replay.of`, so the new run is linked exactly |

With an endpoint, neatroots sends `POST` with JSON:
`{"replay_id", "replay_of", "input", "model", "system_prompt"}` (`model` and `system_prompt` are
`null` when unchanged). Answer when the run is done. A replay stops after 15 minutes.

### Reading the overrides in your agent

The steering hooks do it for you. Read the input where your agent reads its question, and wrap the
client so the model and system prompt overrides apply:

```python
import neatroots_steer
client = neatroots_steer.wrap(OpenAI())                      # applies the model and system prompt
question = neatroots_steer.replay_input(default=sys.argv[1])  # the replay's input, or yours
```

```ts
import { replayInput, wrapOpenAI } from "@neatlogs/neatroots-steer";
const client = wrapOpenAI(new OpenAI());
const question = replayInput(process.argv[2]);
```

`wrap` replaces the system message (or Anthropic's `system`) and the `model` argument only during a
replay; outside one it changes nothing. Install the hooks from the bundle:
`pip install ~/.neatroots/app/steer/python/neatroots-steer` or
`npm install ~/.neatroots/app/steer/ts`. Without the hooks, read the environment variables yourself.

`examples/python-replay` is a complete agent set up this way.

### Replay correlation

A whole-agent replay prefers a new run carrying that replay's exact `neatroots.replay.id` in
resource attributes or the root span's attributes. For a command target, preserve the entry in
`OTEL_RESOURCE_ATTRIBUTES` or set it through the SDK's resource configuration. For an HTTP target,
add the received `replay_id` to the new trace's resource attributes or root attributes. The HTTP trace
API (`/v1/trace`) and Browser SDK trace shape can use
`attributes: { "neatroots.replay.id": replay_id }` on the root. If an agent or framework replaces
`OTEL_RESOURCE_ATTRIBUTES`, merge the replay entry into its own resource attributes.

Only runs first received during the replay are considered; a root can arrive after its children.
Conflicting explicit IDs are rejected. An ID on a child span alone does not establish correlation.

### Linking without the variables

After the agent answers or exits, neatroots waits up to ten seconds for explicit correlation.
If none arrives, it links a run without an ID only when exactly one new same-project candidate
appeared and no other replay overlapped this replay at any point. A run carrying a different
explicit ID is never a fallback candidate. Multiple candidates or any overlapping replay disable
this fallback, even if the other replay has already finished. A matching explicit ID takes priority
over uncorrelated candidates and works during concurrent replays.

The fallback cannot prove which process produced a lone same-project run. Use explicit correlation
when other agents send telemetry to the same project. If neither matching correlation nor the
constrained fallback is available, the replay fails with the existing no new run reached neatroots error.
