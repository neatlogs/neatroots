# import-files

Traces you already have, as files:

- `otlp-trace.json`: an OpenInference trace in OTLP JSON (what an OpenTelemetry file exporter writes), with a failed tool call.
- `http-traces.jsonl`: two Neatlogs HTTP traces, one per line.

```bash
neatroots import otlp-trace.json http-traces.jsonl
```

Or drop them on **Add data → Import files** in the app. Neatlogs Cloud trace exports work the same way.
