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

## Historical named setup (PR #221, 2026-10-16)

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

Then create a **Neatroots** harness in Harness. Verify an explicit synthetic
trace and check result before relying on telemetry; a ready pane is not proof
that instrumentation delivered its spans.

## Historical contributor verification (2026-10-16)

The following table is the PR #221 author’s report for commit
ade7f5b0996d24d867868e5b2b06b133a42a359b on one headless Linux machine.
It was not rerun against the modified setup below and is not current acceptance.

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


## Dependent setup correction

The package now installs locked neatlogs 1.1.28 in a private workspace directory,
refuses conflicting user plugins, and writes a dedicated success marker after
import verification. NOTES.md is no longer treated as proof of instrumentation.
Retry after an initialization failure; the OpenHarness runtime itself only warns
on init failure, so a launched pane is not a readiness receipt.

Install a published revision with:

    harness dsh install https://github.com/neatlogs/neatroots --path integrations/openharness --ref <published-commit>

The package README is self-contained for sparse subdirectory installs. The
original verification above is contributor evidence for PR221, not a rerun of
this correction. Current correction validation is reported separately below.
The unchanged OTEL variables may still produce internal OpenCode telemetry noise.
The exact-trace verifier avoids conflating it with the synthetic agent run.


## Current correction validation (2026-10-18)

Tested with Node 24.18.0, native OpenCode 1.19.2, locked neatlogs 1.1.28,
and OpenHarness commit 7476ac0303000ad62f9ff7f6f9f317abda62e0fd.

- Package tests: 13 passed, including failed install, retry/idempotence,
  conflicting registration, external dependency links, missing/wrong SDK,
  bounded health checks and exact-trace verifier failures.
- Official DSH static check: passes with the expected warning that the success
  marker is absent from the template.
- Official materialization: failed offline install leaves no success marker;
  retry succeeds and preserves an existing NOTES.md.
- Nested Git install at the exact published PR #221 commit: passes. The modified
  package was tested by local linked install; public installation of this
  correction remains unverified until it is published.
- Actual signed-out local daemon DSH create and official restart of the same
  agent: pass. Each phase produced a distinct completed trace accepted by the
  unchanged exact-trace verifier, with linked LLM and tool spans, a matching
  `openharness-smoke` rule finding referencing recorded spans, and completed
  rules-only coverage with no pending jobs. The create trace had 15 LLM spans
  and one tool span; the restart trace had two LLM spans and one tool span.
  This proves bounded local synthetic acceptance, not model-backed checks,
  paid/hosted operation or physical-machine acceptance.

### Explicit local launch route

For that test, the actual daemon's `agent_create` request supplied an explicit
`grid` route with `networkName: "localmock"`, `model: "mock"`, a fixture network
identifier, and the private loopback mock's `/v1` base URL. No remote Grid service
or real provider credential was used. OpenCode configuration enabled only the
synthetic `smoke` tool. The route was saved by OpenHarness and retained by the
same agent's official `agent_restart`.

At the pinned OpenHarness revision, see the public implementations of
[agent creation](https://github.com/autonomous-ai/openharness/blob/7476ac0303000ad62f9ff7f6f9f317abda62e0fd/cli/src/core/agents/create.ts),
[launch defaults](https://github.com/autonomous-ai/openharness/blob/7476ac0303000ad62f9ff7f6f9f317abda62e0fd/cli/src/lib/harnessDefaults.ts),
[explicit routing](https://github.com/autonomous-ai/openharness/blob/7476ac0303000ad62f9ff7f6f9f317abda62e0fd/cli/src/lib/gridLaunch.ts),
and [restart](https://github.com/autonomous-ai/openharness/blob/7476ac0303000ad62f9ff7f6f9f317abda62e0fd/cli/src/core/agents/restart.ts).
Workspace-only model settings do not override the launcher's default-model
policy. Before each test prompt, the running process's arguments and effective
configuration were checked for `-m localmock/mock`, the expected loopback
endpoint, and the absence of an inline model override. That proof applies to
these two tested launches; future launches need their own verification.

Earlier attempts are retained as failure history: an unavailable fixture import,
an unintended built-in tool with no tool-span receipt, and a launcher default
that overrode workspace model settings. A later restart also received its prompt
before offline initialization completed. The successful fixture allowed 65
seconds for readiness after model-route verification, based on an observed
roughly 53-second offline dependency initialization delay. This was a test-fixture
adjustment; no ingest or OpenHarness launch-policy code changed.
