#!/bin/sh
# Runs every example against neatroots and the mock LLM, and checks each one produced a run.
#
#   neatroots start                      # in another terminal (or as a service)
#   sh examples/run-all.sh               # all of them
#   sh examples/run-all.sh python-openai typescript-openai
#
# Needs uv (Python examples) and Node 22+ (TypeScript examples). No API keys.
set -u
cd "$(dirname "$0")"
URL="${NEATROOTS_URL:-http://localhost:4100}"
MOCK="${MOCK_LLM_URL:-http://127.0.0.1:4110/v1}"
NEATROOTS="${NEATROOTS_BIN:-neatroots}"

STATUS=$(curl -sf "$URL/api/status") || { echo "neatroots isn't answering at $URL. Start it: neatroots start"; exit 1; }
# Every example sends to this instance, whatever ports it runs on.
GRPC_PORT=$(printf '%s' "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('config',{}).get('grpc_port') or '')" 2>/dev/null)
export NEATROOTS_URL="$URL" NEATLOGS_ENDPOINT="$URL" NEATLOGS_API_KEY="${NEATLOGS_API_KEY:-neatroots-local}"
[ -n "$GRPC_PORT" ] && export NEATROOTS_GRPC="localhost:$GRPC_PORT"
if ! curl -sf "${MOCK%/v1}/v1/models" >/dev/null; then
  echo "→ starting the mock LLM"
  $NEATROOTS mock-llm >/dev/null 2>&1 &
  MOCK_PID=$!
  trap 'kill $MOCK_PID 2>/dev/null' EXIT
  sleep 1
fi

# example → project it reports as
PAIRS="python-openai:example-openai-support python-anthropic:example-anthropic-assistant python-langgraph:example-langgraph-orders
python-openai-agents:example-openai-agents python-sessions:example-chat-session python-sub-agents:example-sub-agents
python-replay:example-replay python-opentelemetry:example-opentelemetry python-otel-genai-events:example-otel-genai-events typescript-openai:example-typescript-openai
typescript-vercel-ai:example-vercel-ai http-api:example-http-api"

count() { curl -sf "$URL/api/runs?project=$1&limit=500" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['runs']))" 2>/dev/null || echo 0; }

pass=0; fail=0
for pair in $PAIRS; do
  ex="${pair%%:*}"; project="${pair#*:}"
  if [ $# -gt 0 ]; then case " $* " in *" $ex "*) ;; *) continue ;; esac; fi
  before=$(count "$project")
  printf '%-24s ' "$ex"
  case "$ex" in
    python-*) (cd "$ex" && MOCK_LLM_URL="$MOCK" uv run -q agent.py >/tmp/neatroots-example.log 2>&1) ;;
    typescript-*) (cd "$ex" && { [ -d node_modules ] || npm install --silent --no-audit --no-fund; } && MOCK_LLM_URL="$MOCK" npm start --silent >/tmp/neatroots-example.log 2>&1) ;;
    http-api) (cd "$ex" && sh send.sh >/tmp/neatroots-example.log 2>&1) ;;
  esac
  sleep 2
  after=$(count "$project")
  if [ "$after" -gt "$before" ]; then echo "✓ $((after - before)) new run(s) in $project"; pass=$((pass + 1)); else echo "✗ no new run (see /tmp/neatroots-example.log)"; fail=$((fail + 1)); fi
done
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
