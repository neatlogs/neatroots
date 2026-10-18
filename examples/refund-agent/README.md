# refund-agent

A refund agent steered by neatroots: when a check fires mid-run, neatroots puts a short note into
the agent's next LLM call (through `neatroots_steer.wrap`). Watch the notes in the run's
"Notes to the agent" panel.

Run the scripted example without a model or API keys. Install [neatroots](../../README.md#install),
Python 3.10+, [uv](https://docs.astral.sh/uv/) and curl first. These commands use Bash and start
from the repository root; uv installs the script's Python dependencies on its first run.

Use a fresh collector home so existing forwarding or hosted-model settings are not used.
In the first terminal, choose an unused port and start this isolated rules-only collector:

```bash
export NEATROOTS_HOME="$(mktemp -d)"
export NEATROOTS_PORT=14100
unset NEATROOTS_CLASSIFIER_BACKEND NEATROOTS_CLASSIFIER_URL
unset NEATROOTS_LLM_BASE_URL NEATROOTS_LLM_MODEL
cat > "$NEATROOTS_HOME/config.yaml" <<'YAML'
llm:
  enabled: false
  external:
    enabled: false
classifier:
  laya:
    enabled: false
  jevCloud:
    enabled: false
YAML
printf 'Demo directory: %s\n' "$NEATROOTS_HOME"
neatroots start --no-laya --grpc-port 0
```

In a second terminal, start the scripted LLM on another unused port and leave it running:

```bash
cd examples/refund-agent
python3 fake_llm.py 14199
```

In a third terminal, replace `/path/printed/above` with the first terminal's demo directory.
Use the same ports chosen above. Explicit endpoints keep inherited SDK or steering settings
from redirecting this demo. Continue only if both readiness commands succeed:

```bash
cd examples/refund-agent
export NEATROOTS_HOME=/path/printed/above
export NEATROOTS_PORT=14100
export NEATROOTS_URL=http://127.0.0.1:14100
export NEATLOGS_ENDPOINT="$NEATROOTS_URL"
export NEATLOGS_API_KEY=neatroots-local
export NEATROOTS_STEER=1
export LLM_BASE_URL=http://127.0.0.1:14199/v1
unset STEP_DELAY WORKFLOW
curl --silent --show-error --fail --retry 20 --retry-connrefused --retry-delay 1 \
  --retry-max-time 30 --max-time 2 "$NEATROOTS_URL/health"
# The scripted server has no GET route: HTTP 501 here is its expected readiness response.
curl --silent --show-error --output /dev/null --retry 20 --retry-connrefused --retry-delay 1 \
  --retry-max-time 30 --max-time 2 http://127.0.0.1:14199/
neatroots steering gate --project refund-agent
uv run agent.py "Refund order 4512"
```

The fake LLM keeps looking up the missing order until a request contains
`<neatroots-guidance>`, then asks you to check the order id. Open the refund-agent run in
neatroots at `http://127.0.0.1:14100`: a note should be **delivered**, and `requests.jsonl` records
the guidance in the next LLM request. Stop both demo servers with Ctrl+C when finished. The
printed demo directory retains this run's data without changing your existing settings.

Gate mode flushes completed spans before each LLM call and waits up to 300 ms for pending
checks before claiming a note. This gives the fast scripted agent a chance to receive guidance;
checks taking longer than the wait can still miss that call. No model is needed for the rules
that detect its repeated failing lookups.

For an advisory demonstration, leave both servers running and use:

```bash
neatroots steering advisory --project refund-agent
STEP_DELAY=0.5 uv run agent.py "Refund order 4512"
```

Advisory mode keeps the agent running. The delay allows findings time to arrive but does not
guarantee delivery; a run that finishes before its next guided call can leave an expired note.

To use an actual model instead, run Ollama with `gemma4:latest` available (or set `MODEL` to an
installed model), enable gate mode again and run
`LLM_BASE_URL=http://127.0.0.1:11434/v1 uv run agent.py "Refund order 4512"` in the third terminal.
Model behavior varies; the scripted example above provides the predictable demo.
