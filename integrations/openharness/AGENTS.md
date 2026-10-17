# Neatroots

This workspace is observed: every run this agent makes is sent to a **neatroots**
running on this machine at <http://localhost:4100> and checked there. neatroots
catches what went wrong in a run (loops, repeated tool calls, failed or empty runs),
explains it with the span that shows it, and can replay an LLM call.

## What that means for you

- Work normally. The telemetry is on your machine; nothing leaves it unless the
  user turns on cloud forwarding in neatroots.
- After a run you care about, open <http://localhost:4100> (or ask the user to):
  the Overview reads like a chat and lists problems with causes and suggested fixes.
- When neatroots reports a problem in your run, treat it as evidence: the finding
  names the span. Fix the behaviour it points at.

## This workspace

- `NOTES.md` — append one line per change you make.
- The instrumentation prerequisite is documented in the harness repository: the
  agent's LLM calls must be traced (Neatlogs SDK or an OTLP exporter honouring
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). Run `toolchain/doctor.sh` if runs are not
  appearing in neatroots.
