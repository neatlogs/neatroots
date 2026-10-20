#!/bin/sh
# No SDK at all: one JSON tree per trace, POSTed to neatroots' /v1/trace (the Neatlogs HTTP trace API).
set -eu
curl -sS -X POST "${NEATROOTS_URL:-http://localhost:4100}/v1/trace" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer neatroots-local' \
  -d '{
    "name": "support-chat",
    "project": "example-http-api",
    "session_id": "http-demo",
    "input": "Where is my order 1001?",
    "output": "Your order shipped yesterday and arrives in 2 days.",
    "children": [
      {"name": "lookup", "kind": "TOOL", "tool_name": "lookup_order", "input": {"order_id": "1001"}, "output": {"status": "shipped"}, "duration_ms": 40},
      {"name": "answer", "kind": "LLM", "model": "gpt-4o-mini",
       "input": [{"role": "user", "content": "Where is my order 1001?"}],
       "output": "Your order shipped yesterday and arrives in 2 days.",
       "tokens": {"prompt": 24, "completion": 12}, "duration_ms": 350}
    ]
  }'
echo
