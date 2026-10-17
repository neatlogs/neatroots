# Getting started with neatroots

neatroots checks your AI agent while you build it, on your own machine.
- It takes the runs your agent already sends: the Neatlogs SDK, OpenTelemetry, or a plain HTTP call.
- It runs checks on every run, and tells you what went wrong, where, and how to fix it.
- It lets you replay a run, or one LLM call in it, with your changes.
- It gives your coding agent the evidence over MCP, and can add a note to your agent's next LLM call while the run is still going.

Nothing leaves your machine unless you send it.

This guide covers installing neatroots, sending runs, reading what it finds, replaying, and the settings worth knowing. For why it exists and who it is for, see [use-case.md](use-case.md).

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/neatlogs/neatroots/main/install.sh | sh
```

The installer:
- downloads the prebuilt release, one bundle of about 17 MB for macOS and Linux on Apple silicon, Intel and arm64, and checks its checksum;
- uses your Node.js if it is version 22 or newer; otherwise it downloads Node.js 24 into `~/.neatroots/node` and checks its checksum;
- puts a `neatroots` command in `~/.local/bin` and adds that folder to your shell's PATH;
- offers to connect the coding agents it finds (Claude Code, Codex, Cursor and others; see section 9);
- asks whether to download Laya, the local decision model (about 1.4 GB, once; see section 3). Answer no and set up Jev cloud instead;
- needs no sudo and changes nothing outside your home folder, except the MCP settings of agents you agree to connect.

You need macOS or Linux (on Windows, use WSL) and about 70 MB of disk, plus about 1.5 GB if you download Laya.

Everything lands in `~/.neatroots/app`: the app, the steering hooks (`steer/`), the docs, and 15 runnable examples (`examples/`).

Installer options go after `sh -s --`, for example `curl … | sh -s -- --service`:

| Option | What it does |
| --- | --- |
| `--service` | Also run neatroots in the background now and every time you log in |
| `--version <tag>` | Install a specific release, e.g. `v0.2.0` |
| `--connect`, `--no-connect` | Connect the coding agents found here without asking, or don't offer |
| `--laya`, `--no-laya` | Download Laya without asking, or skip it (then set up Jev cloud) |
| `--from-source`, `--ref <branch>` | Clone and build instead of downloading (needs git and pnpm) |
| `--no-modify-path` | Leave your shell profile alone; the installer prints the line to add instead |
| `--dir <path>`, `--bin-dir <path>` | Install somewhere other than `~/.neatroots` and `~/.local/bin` |
| `--uninstall` | Remove neatroots but keep your runs and settings |

## 2. Start it

```bash
neatroots start                  # runs in this terminal; Ctrl+C to stop
neatroots service install        # or: run in the background and start at login
```

Open **http://localhost:4100**. neatroots also listens for OTLP/gRPC on port 4317.

If you said yes to Laya, the first start downloads it in the background. If nobody was asked yet (an unattended install), `neatroots start` asks in the terminal, and the app asks on Home and in Settings → Decision model. Rules work right away, and questions start working once a model is available (next step). `neatroots start --no-laya` runs without Laya.

Check that everything works:

```bash
neatroots doctor
```

## 3. Choose your models

neatroots works in three layers. You only need the first to start.

| Layer | What it does | Default |
| --- | --- | --- |
| **Rules** | Code checks on every span: loops, repeated tool calls, error streaks, leaked keys, failed or empty runs | Always on, no model |
| **Decision model** | Answers each check's yes/no question with a probability | Laya on this machine if you downloaded it, or Jev cloud if you set it up. The LLM answers a question until one of them has earned it |
| **LLM** | Picks the questions that fit your agent, explains problems, writes notes for the agent, summarizes runs, replays LLM calls | A local model (Ollama, LM Studio, llama.cpp, MLX) |

### A local LLM (the default)

Install [Ollama](https://ollama.com), then pull a model:

```bash
ollama pull qwen3:8b          # 16 GB+ machines; gemma4 and llama3.1:8b also work
```

With `llm.model: auto`, neatroots ranks supported installed chat models within a memory tier;
it does not pick the first model returned by the server. To see what it chose, run `neatroots models`.

#### LM Studio, llama.cpp, MLX and other local servers

These servers can be used through their OpenAI-compatible API. Automatic selection has a narrower
requirement: it needs either an exact supported size-tagged ID (for example, `llama3.2:3b`) or
Ollama's optional `/api/tags` metadata with a recognized family and usable `details.parameter_size`.
Without that metadata, an unsized alias such as `llama3.2:latest`, a quantized variant such as
`qwen3:8b-q4_K_M`, or an ID such as `qwen2.5-7b-instruct` is not automatically selected. A size
in an arbitrary model name is not enough to establish support or capacity. An embedding-only
inventory does not supply a chat model.

If auto mode reports `no supported local chat model found`, choose a chat model that fits your
machine and configure its exact served ID. Run `neatroots llm models` to list IDs at the configured
local endpoint. Merge these fields into `~/.neatroots/config.yaml` (or `$NEATROOTS_HOME/config.yaml`
when set), using your server's URL and model ID:

```yaml
llm:
  baseUrl: http://127.0.0.1:1234/v1
  model: qwen2.5-7b-instruct
```

Restart neatroots after editing the file, then run `neatroots llm` to check the configured endpoint
and selection. `NEATROOTS_LLM_BASE_URL` and `NEATROOTS_LLM_MODEL`, if set, override these fields.
Explicit selection bypasses automatic family and capacity checks: you are responsible for choosing
a chat model your server can run. Discovery confirms configuration, not successful inference or
model-answer quality.

Automatic tiers use total system memory rounded to the nearest GiB: small below 16, medium from
16 to below 32, and large from 32. Their parameter ceilings are 4B, 8B and 14B respectively, with 10% tolerance
for rounded sizes; smaller supported preferences remain eligible. These are selection heuristics,
not a guarantee of available RAM or VRAM. Missing or unusable metadata never enables an arbitrary
first-model fallback. Set `llm.model` back to `auto` to restore automatic selection.

### A hosted LLM (opt-in)

If you would rather use Claude or another hosted model, store a key and turn it on:

```bash
neatroots llm login anthropic                          # paste the key; it goes to the macOS Keychain
neatroots llm use anthropic                            # claude-opus-5-5 by default
neatroots llm use anthropic --model claude-sonnet-5-5  # or pick a model
neatroots llm test                                     # one tiny prompt, to confirm it works
neatroots llm local                                    # back to this machine only
```

You can also do this in the app under **Settings → Models**.

- **Providers:** Anthropic, OpenAI, OpenRouter, Google Gemini, Groq, Mistral, Together AI, and any OpenAI-compatible server (`neatroots llm use custom --base-url https://…/v1 --model …`). `neatroots llm providers` lists them, and `neatroots llm models <provider>` lists a provider's models.
- **What is sent:** when a hosted LLM is on, the run content each LLM task needs is sent to that provider. Credentials are removed first: API keys, bearer tokens, JWTs, `Basic` authorization, AWS secret keys, passwords in URLs and private keys (the full list is in [cloud.md](cloud.md)). `--redact all` also removes emails and phone numbers, though that can stop the personal-data check from seeing a leak. Rules, stored runs and the app stay on your machine.
- **Fallback:** if the provider fails or has no key, neatroots falls back to the local LLM. Turn this off with `--no-fallback`.
- **Cost:** neatroots asks the LLM a few questions per run while Laya is learning, and more when it investigates a problem. Pick a smaller model, such as `claude-haiku-5-5`, if your agent runs a lot.

### How long checks take

Rules are instant. Questions take as long as the model answering them: with a local LLM standing in (before Laya has earned a question), each answer is a model call, and the calls run one at a time. On a 24 GB Apple silicon Mac with `gemma4`, the eight sample runs are fully checked about five minutes after they finish, and a busy batch of examples can queue 50 answers. A hosted LLM answers four questions at a time, so the same batch finishes several times faster; questions Laya has earned are answered by Laya instead of the LLM, which is quicker still. The run page shows each run's progress, and anything you ask for yourself (drafting a check, a preview, Explain run, a coding agent's question) goes ahead of the background queue.

### Laya or Jev cloud

Checks are yes/no questions, so neatroots uses a decision model built for them. Pick one:

- **Laya** (local): an open 421M-parameter model on this machine. Free and private; a one-time download of about 1.4 GB. It starts in shadow mode and takes over each question once it agrees with your LLM on 90% of 30 answers. `neatroots laya install` downloads it now; `neatroots laya skip` records that you don't want it.
- **Jev cloud** (hosted, opt-in): TypeSafe's typed-decision API. The span content a question needs is sent to TypeSafe.

Without either, your LLM answers every question, which works but is slower. To use Jev cloud:

```bash
neatroots jev login && neatroots jev on
```

## 4. Send runs

### No agent yet? Use an example

The examples need no API keys: they talk to neatroots' mock LLM, a stand-in that speaks the OpenAI and Anthropic APIs. Python examples need [uv](https://docs.astral.sh/uv/); TypeScript ones need Node 22+.

```bash
neatroots mock-llm &                                    # port 4110
cd ~/.neatroots/app/examples/python-openai
uv run agent.py "Please refund order 1001"
MODEL=mock-sloppy uv run agent.py "Please refund order 4512"   # the agent claims success after a failed tool
sh ~/.neatroots/app/examples/run-all.sh                 # every example, checked
```

`~/.neatroots/app/examples/README.md` lists all fifteen. Set `REAL_LLM=1` to use your own `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` instead of the mock.

### Your agent, with the Neatlogs SDK

neatroots speaks the same protocol as Neatlogs Cloud, so an agent that already uses the Neatlogs SDK only needs two environment variables:

```bash
export NEATLOGS_ENDPOINT=http://localhost:4100
export NEATLOGS_API_KEY=neatroots-local     # any value works locally
```

If the agent isn't instrumented yet:

```python
import neatlogs
neatlogs.init(workflow_name="refund-agent", flush_interval=0.5, instrumentations=["openai"])
```

```ts
import * as neatlogs from "neatlogs";
import OpenAI from "openai";
await neatlogs.init({ workflowName: "refund-agent", flushInterval: 0.5 });
const client = neatlogs.wrapOpenAI(new OpenAI()); // use this client for your calls
```

- `workflow_name` is the project name neatroots shows.
- `instrumentations` (Python) and `wrapOpenAI` (TypeScript) choose what gets traced. `init` alone records only spans you create yourself, so a plain OpenAI agent shows no runs.
- `flush_interval=0.5` (`flushInterval` in TypeScript) sends spans every half second, so neatroots can check a run while it is still going.
- In production, unset `NEATLOGS_ENDPOINT` and the same code sends to Neatlogs Cloud.

In your agent's repository, `neatroots init --project refund-agent --write-env` writes the two variables to `.env` and adds a `.neatroots/checks/` folder for checks your team shares. The SDKs read the environment, not `.env`, so load it when you start the agent: `set -a; . ./.env; set +a` in the shell, `dotenv run -- python agent.py` (or `load_dotenv()` before `neatlogs.init`), or `node --env-file=.env agent.js`. Without that the agent runs normally and neatroots records nothing. To check the path end to end with the SDK's own doctor: `python -m neatlogs doctor --probe`.

### Other ways in

**Add data** in the app shows each of these with this machine's ports filled in.

| Path | How |
| --- | --- |
| Neatlogs Browser SDK | `new Neatlogs({ apiKey: "neatroots-local", project: "my-web-app", endpoint: "http://localhost:4100" })` |
| Neatlogs HTTP trace API | `POST http://localhost:4100/v1/trace` with one JSON tree per trace; `children` sets the hierarchy and neatroots makes the ids. See `examples/http-api` |
| OpenTelemetry over HTTP | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4100/v1/traces` (protobuf or JSON) |
| OpenTelemetry over gRPC | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4317`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc` |

Browser traces are accepted from pages served on this machine (`localhost`, `127.0.0.1`, `[::1]`, any port). To send from a page on another origin, such as a staging site, list it in `config.yaml`, so no other website you have open can write runs that your coding agent then reads:

```yaml
ingest:
  allowedOrigins: ["https://staging.example.com"]   # "*" accepts every website
```

With OpenTelemetry, `OTEL_SERVICE_NAME` becomes the project. neatroots reads Neatlogs, OpenInference, OpenLLMetry (`traceloop.*`), GenAI semantic-convention and Vercel AI SDK attributes, so LLM messages, tool calls, models and tokens show up whichever instrumentation you use.

### Import runs

Bring in runs you already have, to check, explain or replay them here:

```bash
neatroots import traces.json export.jsonl       # OTLP JSON, Neatlogs trace exports, Neatlogs HTTP traces
neatroots import neatlogs-cloud --since 24h     # your Neatlogs Cloud project (needs a service-account token, section 10)
```

**Add data → Import files** in the app takes the same files by drag and drop. Imported runs are checked like any other.

## 5. Read what neatroots found

**Home** shows how your agents have been doing over the last 24 hours, 7 days or 30 days, against the period before. Everything on it is computed from your own runs:
- **Totals:** how many runs had problems or failed, and how long runs take.
- **Needs attention:** problems by how many runs they hit, tools that fail or return nothing, and models with errors.
- **Working well:** projects, tools and models with a clean record, checks that found nothing, and problems you no longer see.
- **What stands out:** the LLM's short reading of these numbers. It sees only the aggregates, never run content, and neatroots drops any sentence that quotes a number not in the data.
- **The guide:** while setup is incomplete, Home shows how to use neatroots, checked against what is actually set up.

The **Runs** page lists each run with what it was asked to do and its most important open problem. A run page:
- leads with the **problems**, each with a one-line cause. Open one to see the suggested fix, the spans that show it, and how sure neatroots is;
- says how much of the run was checked: "4 of 5 questions answered · rules on every span", with a spinner while checks are still running. A green "Nothing found" means every question ran. If no model could answer (none set up, or the provider is down), it says **Only rules checked this run** instead, with **Re-run checks** for when a model is available. Checks that were still queued when neatroots stopped or restarted are finished when it starts again;
- has **Explain run**, where the LLM writes a likely cause for the whole run;
- shows the run four ways:

| View | What it shows |
| --- | --- |
| **Overview** | The run as a chat: the system prompt, what the user asked, what the model answered, each tool call with its input and output, and sub-agents as cards you can open. Edit a user message here to fork the run (section 6) |
| **Trace** | The span tree. Click any span to see its input, output, attributes and findings |
| **Timeline** | Spans on a time axis, with zoom, to see what was slow and what ran in parallel |
| **Conversation** | Every turn of the session this run belongs to, oldest first, with each turn's problems |

- **Dismiss finding:** use it when a finding is wrong. neatroots counts dismissals per check, so you can see which checks are noisy.
- **Mark as issue / good** on a span records your judgment. neatroots uses it when measuring its checks.

**Search** (⌘K or Ctrl+K from anywhere) looks through every span's name, input, output and error, and highlights the hits. Add filters to narrow it down, or use the chips under the box:

| Filter | Example |
| --- | --- |
| `project:` | `project:refund-agent` |
| `status:` | `status:failed`, `status:succeeded`, `status:running` |
| `kind:` | `kind:llm`, `kind:tool`, `kind:agent` |
| `tool:`, `model:` | `tool:lookup_order`, `model:gpt-4o` |
| `check:` | `check:system-prompt-violation` |
| `session:` | `session:abc123` |
| `has:problems` | runs with open problems |
| `since:` | `since:24h`, `since:7d`, `since:2026-10-01` |

A hit opens the run at that span. Search covers span names, errors, and the first 150,000 and last 50,000 characters of every input and output.

## 6. Replay and fork

Replays answer "would it have gone better with a different prompt, model or input?" without rewriting your agent first. Every replay is a new run, linked to the one it came from, and checked like any other.

- **One LLM call** (no agent needed): **Replay** on a run, or **Replay this call** on an LLM span, re-sends that call's messages to neatroots' LLM, without tool definitions. Change the model or the system prompt, or edit a message.
- **Edit and fork:** in the Overview, hover a user message and click **Edit and fork**. **Re-run this LLM call** replays just that call with your edit; **Re-run the agent** runs your whole agent with the new message.
- **The whole agent:** register how to start it once, then use **Replay** with a new input, model or system prompt:

```bash
neatroots rerun add refund-agent "uv run agent.py" --cwd ~/code/refund-agent
neatroots rerun add web-agent --url http://localhost:3000/replay      # or an HTTP endpoint your agent serves
neatroots replay <trace-id> --input "Refund order 2002" --model gpt-4o-mini
```

**Settings → Projects** does the same in the app. See [replay.md](replay.md) for how your agent picks up a replay's input, model and system prompt.

## 7. Checks

The **Checks** page lists everything neatroots watches for:
- **Rules** run in code on every span.
- **Questions** go to the decision model. For each agent, the LLM picks the library questions that fit its goal, system prompt and tools, and may write new ones for risks the library does not cover. Four questions always run on agents that use tools: ignored tool errors, answers that contradict the tools, followed injected instructions, and personal data in the answer.
- **Your own checks:** click **New check**, describe the problem in a sentence, and neatroots drafts a yes/no question. **Preview on recent runs** shows how often it would fire before you save it; preview it on a run that has the problem and one that doesn't. If a check asks about the agent's answer but can't see it, the editor says so (see [checks.md](checks.md)). Drafting and previews go ahead of background checks in the model's queue, and **Cancel draft** / **Cancel preview** stop them.
- **Sharing checks:** keep them in your repository's `.neatroots/checks/` folder to share with your team. `neatroots checks validate <file>` checks the YAML. The format is in [checks.md](checks.md).

## 8. Steering (opt-in)

Steering puts a finding back into the agent while it is still running. It is off until you turn it on for a project, and it needs a small hook in your agent:

```bash
pip install ~/.neatroots/app/steer/python/neatroots-steer
neatroots steering gate --project refund-agent
```

```python
import neatroots_steer
client = neatroots_steer.wrap(OpenAI())   # or Anthropic(); sync or async
```

For TypeScript, run `npm install ~/.neatroots/app/steer/ts` and see [steering.md](steering.md).

| Mode | What happens |
| --- | --- |
| `advisory` | A short note is added to the agent's next LLM call |
| `gate` | Each LLM call waits up to 300 ms for pending checks, then adds the note |
| `self-check` | The agent gets a `check_my_work` tool it can call |

Limits:
- At most one note per LLM call and three per run.
- Only rules you write with `action: halt` can stop a run.
- `neatroots steering stop` turns steering off everywhere at once. The sidebar switch does the same.

## 9. Coding agents

### Over MCP, in the agent you already use

Give your coding agent the runs, findings and explanations:

```bash
neatroots connect                 # pick from the agents found on this machine
neatroots connect cursor codex    # or name them
neatroots connect --list          # what's found and what's connected
neatroots connect --remove cursor
```

Supported: Claude Code, Codex, Cursor, OpenCode, Windsurf, Amp, Gemini CLI, VS Code and Claude Desktop. Claude Code and Codex also get neatroots' four skills (`neatroots-debug-last-run`, `neatroots-write-check`, `neatroots-instrument-agent`, `neatroots-push-to-neatlogs`) in `~/.claude/skills` and `~/.agents/skills`. Each agent gets a `neatroots` entry in its own MCP settings, in the format its docs give; other entries are kept, and the file is backed up once (`*.neatroots-backup`) before the first change. A settings file with comments is left alone, and neatroots prints what to add instead. **Settings → Coding agents** in the app does the same with one click.

Other clients can use the HTTP endpoint `http://localhost:4100/mcp`, or `neatroots mcp` over stdio.

Then ask, for example: *"Fix what neatroots found in my last run, and add a check so it is caught next time."* Your coding agent can:
- read the run, find the problem and explain it;
- search runs, compare two runs, and answer questions with read-only SQL over the local store;
- write a check and preview it on recent runs;
- replay a run or one LLM call, and open what it is talking about in your browser (`show_in_ui`);
- pull a production trace from Neatlogs Cloud to debug it locally.

[mcp.md](mcp.md) lists the 23 tools.

### Inside the app

**Coding agents** in the sidebar chats with Claude Code or Codex in a project folder you pick, with neatroots' tools attached. Each message runs the agent's own CLI on your machine with your own sign-in, and the chat resumes the same agent session. A chat is read-only until you switch on **Allow edits** or **Allow commands** for it. **Ask a coding agent** on a run (in the **More actions** menu) starts a chat about that run.

- neatroots finds the CLIs on your PATH, in the usual install folders (`~/.local/bin`, Homebrew, npm under any nvm Node), and the Codex that ships inside the ChatGPT app. If yours is elsewhere, set `NEATROOTS_CLAUDE_BIN` or `NEATROOTS_CODEX_BIN` to its path.
- If the agent can't sign in (an expired login, or an expired AWS session when Claude Code runs on Amazon Bedrock), the chat says so. Run `claude` or `codex` in a terminal until it works, then send the message again.
- The other agents neatroots connects (Cursor, VS Code, Claude Desktop, Gemini CLI, OpenCode …) are listed below the chat: they run in their own app or terminal, with neatroots' tools already attached. **Open Cursor** and the like open the app.

## 10. Neatlogs Cloud

To keep a run, or share it with your team, send it to Neatlogs Cloud:

```bash
neatroots cloud login              # your app.neatlogs.com project API key (sends runs), stored in the Keychain
```

Then click **Send to Cloud** on a run. neatroots shows what it will remove before it sends anything. To forward every run of a project as it finishes, run `neatroots cloud auto <project> on`.

Importing goes the other way and needs a different credential: a Neatlogs service-account token (`nlsa_…`), because the project API key can only send. Store it with `neatroots cloud token` (or **Settings → Neatlogs Cloud → Import from Neatlogs Cloud**) and choose the project to read. **Add data → Neatlogs Cloud** then lists that project's recent traces and imports the ones you pick, so you can explain, check and replay a production run locally. See [cloud.md](cloud.md).

## What leaves your machine

| Feature | Default | What is sent, and where |
| --- | --- | --- |
| Collector, rules, Laya, local LLM, storage, app, MCP | On | Nothing; all local |
| Hosted LLM | Off | Run content each LLM task needs, minus secrets, to the provider you choose |
| Jev cloud | Off | Span content a question needs, to api.typesafe.ai |
| Neatlogs Cloud forward | Off | Runs you send or a project you forward, redacted first, to ingest.neatlogs.com |
| Neatlogs Cloud import | Off | Requests to app.neatlogs.com with your service-account token |
| Coding agents in the app | Off | Whatever Claude Code or Codex sends to their providers, as when you run them yourself |
| Steering | Off | Notes go to your own agent's next LLM call; nothing leaves the machine |
| Install and update | — | Downloads neatroots, Node.js, packages and Laya |

neatroots listens on 127.0.0.1 only. API keys live in the macOS Keychain (on Linux, a file only you can read in `~/.neatroots`) and never in neatroots' database.

## Commands

| Command | What it does |
| --- | --- |
| `neatroots start` | Run neatroots on port 4100 and OTLP/gRPC on 4317 (`--port`, `--grpc-port`, `--no-laya`) |
| `neatroots service install / uninstall / status / restart` | Run in the background and start at login |
| `neatroots status`, `neatroots doctor` | What is running; whether everything works |
| `neatroots init` | Set up an agent's repository (`--project`, `--write-env`, `--steering`, `--mcp claude`) |
| `neatroots import <files>` | Bring in trace files, or `neatlogs-cloud` traces (`--since`, `--limit`, `--project`) |
| `neatroots replay <trace-id>` | Replay a run (`--span`, `--input`, `--model`, `--system`) |
| `neatroots rerun add / list / remove` | How neatroots starts your agent for replays |
| `neatroots mock-llm` | A stand-in LLM on port 4110 for running agents without API keys |
| `neatroots llm` | Where LLM calls go; `login`, `use`, `local`, `models`, `test`, `providers` |
| `neatroots models`, `neatroots laya install / skip / status`, `neatroots jev login / on / off` | Decision models: Laya (local) or Jev cloud |
| `neatroots steering <mode> --project <name>`, `neatroots steering stop` | Steering |
| `neatroots checks list`, `neatroots checks validate <file>` | Checks |
| `neatroots check <files...>` | Rule checks over saved traces: exit 0 when clean, 1 if a rule fires, 2 for invalid input or check configuration (`--only`, `--checks`, `--json`) |
| `neatroots cloud login / forward / auto` | Neatlogs Cloud: send runs |
| `neatroots cloud token`, `neatroots cloud project` | Neatlogs Cloud: the service-account token and project imports read from |
| `neatroots connect` | Give coding agents neatroots' MCP tools |
| `neatroots mcp` | MCP over stdio for coding agents |
| `neatroots update` | Update to the latest release |

## Update and uninstall

```bash
neatroots update                                       # downloads the latest release and restarts the background service
neatroots connect --remove --detected                  # optional; uninstalling does this too
curl -fsSL https://raw.githubusercontent.com/neatlogs/neatroots/main/install.sh | sh -s -- --uninstall
```

Uninstalling keeps `~/.neatroots`, which holds your runs, settings and Laya. Delete that folder to remove them too. API keys stay in the Keychain under "neatroots".

## Troubleshooting

| Problem | Try |
| --- | --- |
| `neatroots: command not found` | Open a new terminal, or add `~/.local/bin` to your PATH |
| `port 4100 is in use` | neatroots is already running: run `neatroots status`. Or use `neatroots start --port 4200` and point `NEATLOGS_ENDPOINT` at it |
| No runs appear | Check that both variables are set in the agent's process. Run `python -m neatlogs doctor --probe` and `neatroots doctor` |
| Runs appear only at the end | Set `flush_interval=0.5` in `neatlogs.init` |
| An example fails with a connection error | Start the mock LLM (`neatroots mock-llm`) in another terminal |
| "No LLM" in the sidebar | Start Ollama (`ollama serve`) and pull a model, or turn on a hosted LLM. Rules still run without one |
| Laya failed to install | Run `neatroots laya install` to see the error. It needs `uv`, or Python 3.10+ with its matching `python3.x-venv` package on Ubuntu/Debian. Fix the prerequisite and retry; neatroots removes an incomplete environment automatically. neatroots works without Laya: the LLM answers instead |
| Hosted LLM errors | `neatroots llm` shows the error. "Rejected the key": run `neatroots llm login <provider>` again. "Model not found": check `neatroots llm models <provider>` |
| Replay says it doesn't know how to start the agent | Register a command or endpoint: `neatroots rerun add <project> "<command>"`, or Settings → Projects |
| A file won't import | It must be OTLP JSON, a Neatlogs trace export or Neatlogs HTTP traces (one per line in .jsonl); the error says what didn't parse |
| A Neatlogs Cloud import fails | It needs a service-account token, not the project API key: `neatroots cloud token`. A 403 means the token can't read the chosen project: `neatroots cloud project` |
| A chat with Claude Code or Codex says it couldn't sign in | Run `claude` or `codex` in a terminal until it answers (for Claude Code on Amazon Bedrock, refresh your AWS login), then send again |
| Codex or Claude Code shows "not installed" | Set `NEATROOTS_CODEX_BIN` or `NEATROOTS_CLAUDE_BIN` to the CLI's path and restart neatroots |
| Claude Desktop shows "Not connected" after connecting | Claude Desktop rewrites its settings while it runs. Quit it (⌘Q), run `neatroots connect claude-desktop`, then reopen it |
| Steering notes never arrive | Turn steering on for the project, install the hook, and set `NEATROOTS_STEER_DEBUG=1` in the agent to see what the hook does |
| Where are the logs? | The terminal running `neatroots start`, or `~/.neatroots/logs/neatroots.log` for the background service. `NEATROOTS_DEBUG=1` adds detail |
| `~/.neatroots` doesn't get smaller after old runs are removed | That's expected. Past the size cap (Settings → Storage), the oldest unpinned runs are removed until the data is back to 90% of the cap, but the database file keeps its size and reuses the freed space for new runs. So the cap stops it growing; lowering the cap doesn't shrink the folder, and "On disk" can read above the cap |
