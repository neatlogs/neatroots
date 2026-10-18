# Trying neatroots: the tester guide

Thank you for trying neatroots. We want to learn three things from you:

1. **Does it work on your machine without help?** Install, start, see runs.
2. **Does it find real problems, and stay quiet otherwise?** On our samples, and on your own agent.
3. **Does it make building an agent faster?** Do you find, understand and fix problems sooner than
   you do today?

The third matters most, and only you can tell us. The session takes 45 to 60 minutes. Write down
anything that confuses you or takes longer than it should: confusion is a finding too.

## Before you start

- macOS or Linux (Windows through WSL), and about 1.5 GB free if you download Laya.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for the samples and Python examples
  (it fetches a suitable Python by itself). Node 22+ only if you want the TypeScript examples.
- Optional: [Ollama](https://ollama.com) with a model (`ollama pull qwen3:8b`), or an API key for a
  hosted LLM (Anthropic, OpenAI and others). Without one, only the rules run, and explanations and
  LLM replays are off.
- Optional: a coding agent you use (Claude Code, Codex, Cursor, …), and an agent of your own that
  you are building.

No API key is needed to generate the example and sample runs: agents use a stand-in LLM. The
model-judged sample checks still need Laya, Jev cloud, or a real local or hosted LLM; the stand-in
is deterministic test plumbing, not a useful judge.

## 1. Install (5 minutes)

```bash
curl -fsSL https://raw.githubusercontent.com/neatlogs/neatroots/main/install.sh | sh
```

Say yes when it offers to connect your coding agents. It then asks whether to download Laya, the local model that answers neatroots' checks (about 1.4 GB). Say yes unless you'd rather use Jev cloud; if you say no, set up Jev with `neatroots jev login && neatroots jev on` (it needs a TypeSafe API key from typesafe.ai). Then open a new terminal:

```bash
neatroots start
```

In a second terminal:

```bash
neatroots doctor
```

- [ ] The installer finished without errors. Note how long it took.
- [ ] It explained what Laya is for before asking, and nothing large downloaded until you said yes.
  Your choice shows on Home ("Choose how checks get answered") and in Settings → Decision model.
- [ ] `neatroots doctor` shows ✓ for "neatroots answers" and for "trace round trip".
- [ ] http://localhost:4100 opens, and Home shows how to get started.

If the install fails, keep the last 30 lines of `~/.neatroots/install.log` for your report.

If you have a model: run `neatroots models` (local) or `neatroots llm login anthropic && neatroots llm use anthropic` (hosted), and check the sidebar shows the model.

## 2. The samples: does it catch what it should? (10 minutes)

Eight scripted runs of a support agent. Each has a known problem, except `happy` and `long-request`.

```bash
neatroots steering gate --project support-agent
uv run ~/.neatroots/app/examples/samples/run_samples.py
```

Then check the **Runs** page against this table. On a local model, checks finish a few minutes after the runs do; each run page shows how many of its questions have been answered so far.

| Scenario (the request) | What neatroots should flag |
| --- | --- |
| loop-404 ("Please refund order 4512.") | Same tool called repeatedly with identical arguments. A note reaches the agent and it stops retrying |
| ignored-error | Carried on after a failed tool call |
| injection | Followed instructions found inside tool content |
| pii-leak | Personal data in the answer |
| contradiction | The reply contradicts what the tools returned (or broke a system-prompt instruction) |
| secret-leak | Something that looks like a secret key in model output |
| happy | Nothing |
| long-request (a long customer message, then lookup and refund) | Nothing. The lookup happened before the refund, so "look up an order before refunding it" was followed |

Rules alone, with no LLM, catch loop-404 and secret-leak. The others need a local or hosted LLM.

To score it rather than eyeball it, run the scorer. It waits until every sample is fully checked (several minutes on a local model), then prints what each one raised against what it should:

```bash
uv run ~/.neatroots/app/examples/samples/score.py
```

If the stand-in mock LLM is answering checks, the scorer warns before the results and tells you how
to configure a meaningful decision source. Its model-based verdicts should not be treated as a
neatroots accuracy result.

- [ ] Every flagged scenario shows its problem. Note any that don't.
- [ ] `happy` shows no problems. Note any false alarm.
- [ ] From the run list alone, you can tell which runs went wrong and how.
- [ ] On a run page, you understood the problem without opening the trace.
- [ ] The loop-404 run shows a note under "Notes to the agent".
- [ ] **Home** lists the problems under "Needs attention", and `lookup_order` as a failing tool.

## 3. Reading runs (10 minutes)

Start the stand-in LLM and run three examples:

```bash
neatroots mock-llm &
cd ~/.neatroots/app/examples
(cd python-openai-agents && uv run agent.py)     # a handoff between two agents
(cd python-sessions && uv run agent.py)          # a three-turn chat
(cd python-openai && MODEL=mock-sloppy uv run agent.py "Please refund order 4512")
```

- [ ] **Overview** on the handoff run reads like a chat. **Open sub-agent** shows that agent's own
      messages and tool calls, and the breadcrumb brings you back.
- [ ] **Timeline** shows which steps took the time.
- [ ] **Conversation** on any turn of the chat shows all three turns.
- [ ] The sloppy run is flagged: the agent claimed success after a failed tool. (Needs an LLM.)
- [ ] **Search** (⌘K): find `4512`, then try `status:failed` and `kind:tool`. A hit opens the run at
      that span.

## 4. Replay and fork (10 minutes)

Replays need an LLM (local or hosted) for single calls.

- [ ] On the sloppy run, **Replay → One LLM call**: change the system prompt to forbid claiming
      success after a tool error, and replay. The replay opens as a new run.
- [ ] In the Overview, **Edit and fork** the user message and **Re-run this LLM call**.

Now a whole-agent replay:

```bash
neatroots rerun add example-replay "uv run agent.py" --cwd ~/.neatroots/app/examples/python-replay
(cd ~/.neatroots/app/examples/python-replay && uv run agent.py)
```

- [ ] On that run, **Replay → Re-run the agent** with a different input and model. A new run
      appears, linked to the original, with your input.

## 5. Your own agent: does it help? (15 minutes, the important part)

Before you connect it, write down one line: **how do you find out today why a run of your agent went
wrong?** (print statements, logs, a trace viewer, reading code, …) and roughly how long it takes.

Then point the agent at neatroots. With the Neatlogs SDK it is two variables:

```bash
export NEATLOGS_ENDPOINT=http://localhost:4100 NEATLOGS_API_KEY=neatroots-local
```

With OpenTelemetry or no SDK, **Add data** in the app shows the other ways in. Trace files you
already have go in through **Add data → Import files**.

Run it several times, including at least once where you expect it to go wrong.

- [ ] Its runs appear while they run (set `flush_interval=0.5` if they only appear at the end).
- [ ] The Overview shows its messages and tool calls correctly. Note anything missing or wrong.
- [ ] What neatroots flagged was real. **Dismiss** anything that wasn't, and note it.
- [ ] Note anything it missed that you would have wanted flagged.
- [ ] **New check** on the Checks page turned a one-sentence concern into a check that previewed
      sensibly.
- [ ] A replay let you test an idea without editing code.

## 6. The coding-agent loop (10 minutes)

If you didn't connect your coding agent during install, run `neatroots connect`.

In your agent's repository, ask your coding agent: *"Look at my last run in neatroots, explain what
went wrong, fix it, and add a check so it's caught next time."*

- [ ] It found the run and the problem without you pasting anything.
- [ ] Its fix addressed the real cause.
- [ ] It created a check, and the check appears on the Checks page.

Then try the same from inside neatroots: **Coding agents** in the sidebar, pick your agent and the
repository folder, and ask the same question.

- [ ] The chat answered with neatroots' evidence, and only edited files after you allowed edits.

## What to report

Open a [tester report](https://github.com/neatlogs/neatroots/issues/new?template=tester-report.yml)
on GitHub. It asks for:

- **Machine and setup:** e.g. M3 Pro 36 GB, macOS 26; which LLM; which coding agent.
- **Install:** worked or not, how long, Laya or Jev cloud (and whether the choice was clear), log lines if it failed.
- **Samples:** which of the six problems were caught; any false alarm on `happy` or `long-request`.
- **Your agent:** framework and how it sends runs; real problems found, false alarms, misses.
- **Before and after:** how you debugged before, and how long it took; how long the same kind of
  problem took with neatroots; whether your coding agent fixed it in one go.
- **Ratings, 1 to 5:**
  - I understood what went wrong in a run without reading the raw trace.
  - neatroots found problems I would have missed.
  - False alarms were rare.
  - Replaying let me test ideas without changing code.
  - My coding agent fixed problems faster with neatroots than without.
  - I would keep neatroots running while I build agents.
- **Confusing or slow:** anything in the app or the docs that wasn't obvious, or took more than a
  few seconds.

Found a bug? Open a [bug report](https://github.com/neatlogs/neatroots/issues/new?template=bug-report.yml).
Please don't paste API keys or customer data from your runs.

## Known limits

- **Laya**, the local decision model, is still learning. On our labeled set it gets 7 of 12 right
  without training, so the LLM answers each question until Laya agrees with it on 90% of 30 answers.
- **Probabilities** are not yet calibrated against human labels. When an LLM answered, the run page
  says "Very likely (LLM judgment)" instead of a number; a percentage from Laya or Jev is still a
  model's estimate, not a measured rate. If a check keeps flagging healthy runs, dismiss its findings:
  after 3 dismissals in a project it goes quiet there. Then tell us which check it was.
- **Planning:** the first run of a new agent waits for the LLM to pick its questions, which can take
  up to a minute on a local model.
- **Steering and replay hooks** install from `~/.neatroots/app/steer` until they are published to
  PyPI and npm.
- **Coding agents in the app** need the Claude Code or Codex CLI installed and signed in.
- **Windows:** only through WSL.
