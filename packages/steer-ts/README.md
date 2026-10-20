# @neatlogs/neatroots-steer

The steering hook for [neatroots](https://github.com/neatlogs/neatroots), for TypeScript agents.
When neatroots finds a problem in a run that is still going, this hook adds neatroots' short note to the
agent's next LLM call inside a `<neatroots-guidance>` block and records a `neatroots.guidance` span. It never
edits tool calls or model output, and does nothing when neatroots is not running.

```bash
npm install @neatlogs/neatroots-steer
```

```ts
import * as neatlogs from "neatlogs";
import OpenAI from "openai";
import { configure, wrapOpenAI } from "@neatlogs/neatroots-steer";

await neatlogs.init({ workflowName: "refund-agent", flushInterval: 0.5 });
configure({ neatlogs });                       // share the SDK instance with the hook
const client = wrapOpenAI(new OpenAI(), { telemetry: neatlogs });
```

Pass the **raw** provider client and the public Neatlogs module to the adapter. For Anthropic,
use `wrapAnthropic(new Anthropic(), { telemetry: neatlogs })`. Keep the returned client:
the adapter does not modify the original, and `withOptions()` returns another steered client.
Without `telemetry`, these wrappers add steering only.

Do not nest `neatlogs.wrapOpenAI()` or `neatlogs.wrapAnthropic()` inside or outside this adapter.
Those opaque wrappers return plain Promises and cannot preserve native response helpers. The
explicit adapter records one LLM span after guidance/replay has prepared the request, using the
public `neatlogs.trace()` API. OpenAI chat/responses parsing and Anthropic streaming keep the
provider's real response, request ID, status, errors and cancellation.

`asResponse()` leaves the body unread and finishes a metadata-only span at response headers.
Normal JSON calls record their returned data and reported token usage. Streaming spans finish
when consumed, aborted or closed; they preserve observed assistant text and tool calls, including
partial output on errors or cancellation, with reported usage and an event count. Output is
serialized at termination, not on every chunk. An unconsumed request/stream can leave a span open.
Disable separate provider auto-instrumentation to avoid recording the call twice.

Vercel AI SDK:

```ts
import { wrapLanguageModel } from "ai";
import { rootsMiddleware } from "@neatlogs/neatroots-steer";
const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: rootsMiddleware() });
```

Turn steering on for the project in neatroots (it is off by default):

```bash
neatroots steering advisory --project refund-agent   # or gate, self-check, off
```

Also available: `wrapAnthropic`, `applyMessages`, `applyAnthropic`, `guidance()`,
`CHECK_MY_WORK_TOOL` / `ANTHROPIC_CHECK_MY_WORK_TOOL` with `checkMyWork(question)` and
`handleToolCall(name, args)`, and `NeatrootsHalt` for your own halt rules.

Configuration: `NEATROOTS_URL` (default: a local `NEATLOGS_ENDPOINT`, else `http://localhost:4100`),
`NEATROOTS_STEER=off` to disable, `NEATROOTS_STEER_DEBUG=1` to log each claim. If you trace without the
Neatlogs SDK, pass `configure({ traceId: () => currentTraceIdHex })`.

Rewrapping our facade without options keeps it unchanged. Supplying explicit options replaces
its telemetry configuration using the original raw client; `{}` selects steering only.
