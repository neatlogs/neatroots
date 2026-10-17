# neatroots for OpenHarness

An OpenHarness domain-specific harness (DSH) whose agent's runs are checked by a
neatroots on the same machine (<http://localhost:4100>). Part of issue #172,
milestone 1; the write-up and verification table live in
[`docs/openharness.md`](../../docs/openharness.md).

## Install

```sh
harness dsh install /path/to/neatroots/integrations/openharness --link
harness dsh doctor neatlogs/neatroots
```

## What the package contains

- `harness.json` — the manifest; `agent.env` points the agent's telemetry at
  same-machine neatroots (`NEATLOGS_*` and `OTEL_EXPORTER_OTLP_*`)
- `toolchain/init-workspace.sh` — installs the instrumentation prerequisite (the
  Neatlogs TypeScript SDK and its `NeatlogsOpencodePlugin`) in each workspace
- `toolchain/doctor.sh` — readiness checks: the engine, and a neatroots on :4100
- `AGENTS.md` — what the engine is told about the observed workspace
- `template/` — a fresh workspace
