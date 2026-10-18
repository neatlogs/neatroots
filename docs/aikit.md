# Running neatroots with Razer AIKit

Razer AIKit runs local models behind a vLLM server. neatroots can use its existing
OpenAI-compatible local transport; no AIKit SDK or hosted-provider account is needed.
The preset fills an expected address. It does not install AIKit or verify compatibility.

## Set up the local server

This guide references AIKit **v0.8.0**, source revision
`0505211a716504a6ec36c6845682ef55d0c7604a`. AIKit is a Preview release; recheck the
instructions for the version you install.

Follow AIKit's [pinned setup guide](https://github.com/razerofficial/aikit/blob/0505211a716504a6ec36c6845682ef55d0c7604a/docs/setup.md).
It describes Windows 11 through WSL 2 and Ubuntu 22.04/24.04 or compatible Linux,
Docker, NVIDIA GPU access and a model cache. Its container example uses a mutable
`latest` tag: record the actual image digest and CLI version for reproducible results.
Choose a model that fits your available GPU memory and follow its license/access terms.
No other platform or GPU compatibility is established here.

The linked guide includes a blanket WSL inbound-firewall allow command. Local
loopback use does not require that blanket permission. If your network setup needs
an inbound rule, restrict it to the required port and trusted source addresses;
do not allow all inbound connections merely to follow this local setup.

In your AIKit environment, the documented serving command is:

```sh
rzr-aikit model run YOUR_MODEL_ID
```

The [v0.8.0 inference guide](https://github.com/razerofficial/aikit/blob/0505211a716504a6ec36c6845682ef55d0c7604a/docs/inferencing.md)
and [serving source](https://github.com/razerofficial/aikit/blob/0505211a716504a6ec36c6845682ef55d0c7604a/rzr_aikit/model/run.py)
describe port 8000 by default and the `--served-model-name` option. From neatroots,
the expected base URL is `http://localhost:8000/v1`. If AIKit runs inside WSL or a
container, confirm that its port is reachable from the environment running neatroots.
The UI also accepts a manually entered server address.

Open **Settings → LLM → Change the local server**. Choose **Razer AIKit** to fill that
URL, or **Ollama** to fill `http://localhost:11434/v1`. Both buttons leave your model
field unchanged and do not save anything. Enter the model ID reported by the server
(including any served-model-name alias), or use `auto` to let neatroots choose from
its model listing. Then choose **Save local server**. Hosted settings are separate.

## Record an explicit local verification

From a source checkout with dependencies installed, run the opt-in verifier against
an already running loopback server:

```sh
pnpm --filter @neatlogs/neatroots exec tsx scripts/verify-local-llm.ts \
  --endpoint http://localhost:8000/v1 \
  --model YOUR_SERVED_MODEL_ID \
  --runtime 'AIKit 0.8.0; image digest; model revision'
```

No arguments prints usage and exits unsuccessfully; `--help` prints usage. The tool
never discovers, starts or installs servers, reads user runs/configuration, or sends
credentials. It permits only explicit HTTP loopback `/v1` endpoints and refuses
redirects. Run it in the same network environment as the selected server.

The tool uses the public `LlmClient` with synthetic prompts and an isolated local
request recorder. It prints JSON containing the supplied runtime label, model listing,
auto selection, basic chat, JSON-schema validation, token logprobs and each attempted
request's parameters/status. This includes actual retries/downgrades made by the
existing transport. It does not record headers or response text. The overall limit
defaults to 45 seconds, with bounded request count and body sizes. Optional
`--timeout-ms` selects an integer from 100 through 45000 milliseconds. Each chat
request uses that budget, and a shared abort still limits the entire observation
to the selected deadline; retries do not reset it. Lower values may reject a cold
model before it answers.

The verifier uses exit 0 when these observations pass, 1 when a probe fails, and 2
for an invalid invocation; a package runner may wrap nonzero codes (pnpm reports 1
for an invalid invocation). A valid JSON answer after a schema downgrade is recorded
as such; it does not prove strict schema enforcement. Missing logprobs fail the
logprob check even if text generation succeeds. Runtime labels are operator supplied,
so retain the actual image/version/model evidence alongside the report.

## Evidence and remaining acceptance

| Check | Evidence available here |
| --- | --- |
| Default port, serving command, optional model alias | Pinned v0.8.0 documentation/source |
| Preset draft/save behavior and model preservation | Automated local UI fixtures |
| Recorder, real LlmClient requests, schema retry and failure handling | Automated mock-server fixtures |
| Named AIKit image/CLI/model; models and auto resolution | **Pending real-runtime verification** |
| Named AIKit basic chat, strict schema/downgrades and logprobs | **Pending real-runtime verification** |
| AIKit decision-model available/yes-no/choice/score | **Pending; no decision preset supplied** |

Mock-server passes establish the neatroots plumbing, not AIKit model compatibility,
calibration quality or support for every model. Publish successful and failed real
observations with their exact image/CLI/model versions; do not replace this pending
table with a compatibility claim based on mocks.

## Decision models are a separate contract

AIKit documents a SystemOne wrapper on port 8001 for supported Mapika and AutoTrust
decision models. Similar endpoints alone do not establish compatibility. neatroots'
`JevBackend.available()` sends a typed yes/no request, and `decide()` expects named
answers with probabilities in the fields its parser consumes.

AIKit v0.8.0's AutoTrust backend requires exactly six score levels, whereas neatroots'
default score question has five. See the [pinned backend](https://github.com/razerofficial/aikit/blob/0505211a716504a6ec36c6845682ef55d0c7604a/vllm_plugins/vllm_plugins/systemone/backends.py).
No decision-model preset ships here. It requires separate named-runtime evidence for
availability, yes/no, choice and the existing score semantics; changing or padding
those semantics merely to pass a request is not a compatibility fix.
