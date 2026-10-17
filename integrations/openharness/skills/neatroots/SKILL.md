---
name: neatroots
description: Read this agent's own runs in the same-machine neatroots. Use after a turn the user calls out, or when something went wrong and the evidence is in the trace.
---

# Check your runs in neatroots

neatroots on this machine (<http://localhost:4100>) holds a trace of every turn this
workspace makes: the calls you ran, what came back, and what its checks flagged.

```bash
curl -s http://localhost:4100/api/runs | head -c 2000          # recent runs
curl -s http://localhost:4100/api/runs/<trace_id>              # one run, spans included
curl -s 'http://localhost:4100/api/search/runs?q=<text>'       # search
```

A finding names the span; the span names the call. Fix what it points at and record
it in `NOTES.md`.
