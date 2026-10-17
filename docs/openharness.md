# neatroots on OpenHarness

OpenHarness (the open-source command centre for coding agents) launches agents in
tmux panes on your machines; neatroots checks what those agents do. This directory
is an OpenHarness domain-specific harness (DSH) for neatroots: a harness package
whose agent's runs are traced to a neatroots on the same machine. It implements the
first milestone of #172 (same-machine proof of concept).

## How it works

OpenHarness applies a DSH's `agent.env` on agent create and on every relaunch. This
package sets the telemetry variables there:

- `NEATLOGS_ENDPOINT` / `NEATLOGS_API_KEY` for agents instrumented with the Neatlogs SDK
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` /
  `OTEL_SERVICE_NAME` for engines with their own OpenTelemetry exporter

Setting exporter variables configures an exporter; it does not instrument an agent.
The instrumentation prerequisite is the agent's own, and the named setup below states
it.

## Named setup (Milestone 1)

| | |
|---|---|
| Engine | OpenCode (verified on 1.18.30 and 1.19.2) |
| Instrumentation prerequisite | the Neatlogs TypeScript SDK's `NeatlogsOpencodePlugin` (npm `neatlogs`), registered in the workspace; the DSH's workspace init installs it |
| Export | `NEATLOGS_ENDPOINT` / `NEATLOGS_API_KEY` from `agent.env` |
| OpenHarness | daemon `v0.4.16-dev`, headless Linux; local agents need no account |
| neatroots | this repo, `neatroots start` on `localhost:4100` |

The plugin turns each agent turn into one neatroots trace: a workflow span for the
turn, one LLM span per assistant message, one tool span per tool execution.

## Install and run

```sh
harness dsh install /path/to/neatroots/integrations/openharness --link
harness dsh doctor neatlogs/neatroots
```

Then create a **Neatroots** harness in Harness and talk to the agent as usual.
Every turn appears in neatroots at <http://localhost:4100>.

## Verification (2026-10-16, one headless Linux machine)

Every step was run against this package as shipped.

| Step | Result |
|---|---|
| `harness dsh install … --link` | pass; doctor: `ok sh`, `ok opencode`, `ok neatroots on :4100` |
| OpenHarness `store/tools/dsh-e2e.mjs <machineId> neatlogs/neatroots opencode <workspace> --keep --no-verdict` | pass (exit 0): create, workspace materialize, viewer up, `HARNESS_DSH` on the pane |
| `agent.env` reaches the engine process | pass: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `NEATLOGS_ENDPOINT`, `NEATLOGS_API_KEY` all present in the pane process environment |
| workspace init | pass: `npm install neatlogs` and the `.opencode/plugin/neatlogs.ts` registration present in the workspace |
| one real turn (a tool-using prompt against neatroots' mock LLM, no API keys) | pass: one turn-trace in neatroots, 11 spans (4 LLM, 7 tool), project `neatlogs.opencode` |

### Engine notes, checked the same day

`agent.env` was probed against the engines available on the machine. "Out of the
box" means with only the variables this DSH sets.

| Engine | Telemetry export | Usable for this pairing? |
|---|---|---|
| OpenCode 1.18.30 / 1.19.2 | OTLP logs and internal spans honour `OTEL_EXPORTER_OTLP_ENDPOINT`; no LLM-semantic spans out of the box | yes, with the Neatlogs plugin above |
| Antigravity (`agy`) | OpenTelemetry present but internal only: no OTLP payloads with `OTEL_EXPORTER_OTLP_*` and `OTEL_TRACES_EXPORTER=otlp` set | not yet |
| Hermes | no OpenTelemetry export surface found | not yet |

Two honest findings from the run:

1. **Internal-telemetry noise.** With `OTEL_EXPORTER_OTLP_ENDPOINT` set (as this DSH
   does, per the proposal in #172), OpenCode's own internal spans (`InstanceStore.boot`,
   `sql.execute`, and so on) also land in neatroots: hundreds of small runs appeared
   beside the real turn-trace during one session. A next step is to decide together
   whether neatroots' ingest should classify or drop these, or whether the DSH should
   drop the `OTEL_*` variables when the Neatlogs plugin is the transport (the plugin
   does not need them).
2. **Short-lived processes lose spans.** An `opencode run` one-shot exits before its
   OTLP span batch flushes (the Neatlogs SDK documents the same race and ships its own
   spans with awaited requests instead). Long-lived sessions, the normal case in a
   Harness pane, export fine.

## Scope

Same machine only: the agent and neatroots run on one machine and the exporter points
at loopback, per #172's milestone 1. Broader engine coverage is follow-up work, engine
by engine.
