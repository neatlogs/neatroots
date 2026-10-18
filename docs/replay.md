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

### Linking without the variables

If the agent drops `OTEL_RESOURCE_ATTRIBUTES` (some frameworks set their own resource), neatroots
links the first new run of that project that starts after the replay began.

## Replay batches

Register how to start your agent with `neatroots rerun add <project> "<command>"`
or a local HTTP replay endpoint. Then run:

```sh
neatroots replay <trace-id> --times 10
```

`times` must be an integer from 1 through 20. Each whole-agent repeat runs
sequentially and remains an ordinary replay record linked to the original.
Omitting `--times` keeps the existing single-replay behavior. Repeating a single
LLM call (`--span`) is not supported. In the app, choose **Replay → Re-run the
agent**, set **Repeat count**, and read **Replay batches** on the original run.

The summary counts a check once per checked repeat, even if it produced multiple
findings. It includes checks found on the original run and checks newly found in
repeats. The denominator is the number of successfully checked, explicitly linked
repeats, not the requested count. Quiet and dismissed findings count as observed problems: quiet suppresses delivery,
and dismissal does not erase a recorded occurrence. Failed evaluations do not count
as findings and exclude that repeat from the denominator. Original presence is
snapshotted when the batch starts. Agent runs with error/interrupted status, or a
nonzero process exit, still contribute findings when evaluation succeeds. Execution
and evaluation failure counters are separate and may overlap; only a successful
agent run without observed findings counts as clean.

Only unique `neatroots.replay.id` evidence counts as linked. Agents should echo
`NEATROOTS_REPLAY_ID` in this resource or span attribute (command replays also pass
it through `OTEL_RESOURCE_ATTRIBUTES`). A local HTTP endpoint receives `replay_id`
in its request body. An ordinary replay associated by the existing fallback is
shown as **unlinked** in the batch. Conflicting IDs and multiple matching traces
are also unlinked. Existing replay navigation and comparison remain available.

Clean requires a successful completed run and a successful end-pass receipt with no pending
tracked work or failed checks. Unknown, skipped/unavailable checks and interrupted
processing never imply clean. Late telemetry invalidates an earlier receipt;
uncertain runs remain pending. Receipts are tied to a processing generation; stale work cannot certify later
telemetry or rechecks. Deletion invalidates receipts and stops remaining repeats
for a deleted original. Summary reads refresh as checks finish. A batch can
finish dispatching while checks are still pending, and zero findings with zero
checked repeats is not evidence of a fix.

Cancel with **Cancel remaining repeats**, Ctrl+C in the batch CLI, or the batch
API. Cancellation stops subsequent repeats; active work may finish under its
existing timeout. It does not claim to kill the active command. The existing
15-minute timeout per replay remains; an additional batch watchdog bounds waiting
and stops dispatch if process termination cannot be confirmed. After a server
restart unfinished batches become interrupted and are not resumed automatically.

MCP `rerun` accepts optional `times`; MCP `replay` accepts `times` with no
`span_id`. Without `times`, `replay` still requires an LLM `span_id`.
`replay_batch` takes `batch_id` to read the latest summary and optional
`cancel: true` to stop remaining repeats. The tool's wait can expire while a batch
continues; retain its ID and poll.

HTTP uses `POST /api/runs/:traceId/replay` with `times` and the existing overrides.
Read `GET /api/replay-batches/:id` or `GET /api/runs/:traceId/replay-batches`;
cancel with `POST /api/replay-batches/:id/cancel`. Existing single-replay routes and
responses are unchanged when `times` is omitted. Batches add local SQLite metadata
only; span storage remains lossless, and no new remote service or credential is
used. Existing explicit hosted-model configuration still applies to checks.

Batch correlation metadata retains only locally generated batch attempt IDs, with
at most two candidate traces per attempt. Foreign identifiers are represented by
a conflict flag, never copied into batch metadata. Evidence scans beyond 512 spans
or attributes remain conservatively unlinked. Original-run deletion or retention
removes its batches; deleting a produced run removes its derived observations and
invalidates that member's link. `DELETE /api/replay-batches/:id` removes a batch and
its metadata and stops further repeats. An active task may finish, but cannot
recreate deleted batch metadata. Deleted batch promises return a redacted cancelled
result with no finding counts, rather than retaining deleted trace information.

The generic engine receipt is available as `roots.checkCompletion.state(traceId)`
(`pending`, `failed`, or `settled`) and `requiresRecheck(traceId)`. Identical
redelivery preserves settlement. Provisional and live span updates are checked
automatically; superseded in-flight answers are discarded. Replacing or adding
evidence after the end pass starts marks the run as requiring **Re-run checks**;
stale asynchronous work cannot certify it. A fresh recheck resets failed/end
state before either phase starts. Receipt state is independent of replay batches.
Execution failures without verified links also count as unlinked; these counts
can overlap. Unique explicit batch evidence corrects the ordinary replay's
navigation even if its timing fallback selected another run.

Completion remains pending for accepted span queues and end-only retries, even if
their worker fails. End-only retries do not block execution idleness or `waitIdle`.
A job finalizer can certify only its own evaluation generation. A failed busy
queue therefore cannot turn a newer or incomplete evaluation into a clean repeat;
rechecking rebuilds that evaluation from the stored trace.

Known deferred investigation work also prevents a completion receipt, even when
execution is idle. Late triage arriving after the engine's single end drain may
therefore leave a repeat pending. This change does not drain or recover that late
work (the adjacent end-pipeline fix owns that behavior), and does not change
`waitIdle` or gate semantics. No clean result is inferred from execution idleness.
