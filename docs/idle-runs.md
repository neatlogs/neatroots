# Runs with no completion marker

neatroots infers an interruption when a running, non-doctor run has received no
spans for ten minutes. This means activity is missing; it does not prove that the
agent process died. No root span, successful result or producer completion marker
is fabricated. Raw telemetry is unchanged.

Set `runIdleMinutes` in config.yaml, or POST `run_idle_minutes` to /api/settings.
The default is 10; valid values are 1 through 10080 minutes, or 0 to disable idle
inference and its automatic end processing. A long silent tool call can exceed
the limit while still running: increase the limit or disable it for that workload.
Invalid persisted values use the default; invalid API values are refused before
applying any settings.

The durable liveness clock is the server's wall-clock receipt time of each span,
including a replacement of an existing span. Exporter timestamps, old imports and
future timestamps do not establish liveness. A local wall-clock adjustment can
delay or advance expiration. Existing running rows without a recorded receipt
get a fresh grace period when first encountered after upgrade; historical exporter
timestamps are not used to expire them immediately.

Startup and a one-minute timer each inspect a bounded page: at most32 legacy
receipts initialized and16 running rows interrupted per sweep. At most four
inferred-end jobs are started concurrently. A large backlog takes multiple sweeps;
this is not a promise that every run is processed within one minute. End checks
reuse the existing engine and model availability policy. Without an engine the
run is still honestly marked interrupted, and pending end work remains durable
for a later start with an engine. Failed work leaves interrupted check progress;
it is not represented as successfully settled checks.

Late children update receipt metadata but do not reverse an inferred interruption.
An actual ended root or completion marker clears only the locally owned inference.
Explicit producer interruptions remain interruptions. Locally inferred run-failed
findings are resolved, not deleted, and unrelated findings/annotations remain.
An inferred summary is replaced only when its text still matches the locally
recorded summary. Real completion processing is serialized after any in-flight
inferred end pass; duplicate completion updates do not create parallel end passes.
