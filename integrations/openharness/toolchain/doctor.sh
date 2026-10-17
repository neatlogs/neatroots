#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
command -v sh >/dev/null 2>&1 && echo "ok   sh" || { echo "miss sh"; exit 1; }
command -v opencode >/dev/null 2>&1 && echo "ok   opencode" || { echo "miss opencode (the engine)"; exit 1; }
curl -sf http://localhost:4100/health >/dev/null 2>&1 && echo "ok   neatroots on :4100" || {
  echo "miss neatroots on :4100 (start it: neatroots start)"
  exit 1
}
