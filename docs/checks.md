# Checks

A check is anything neatroots watches for. Checks are YAML, loaded from (later wins on the same id):

1. the shipped library (`packages/neatroots/library/`),
2. `~/.neatroots/checks/`,
3. each project's `.neatroots/checks/` registered with `neatroots init`,
4. questions the planner or a coding agent wrote (kept in the database until you save them).

## Saved traces in CI

Run the existing offline rule checker and redirect its JUnit output to a file:

```sh
neatroots check traces.json traces.jsonl --junit > agent-checks.xml
```

No server, model or API keys are needed. `--checks <dir...>` adds check folders and
`--only id1,id2` limits the rules, just as with text or `--json` output. `--junit`
and `--json` are mutually exclusive.

Each trace run becomes one test case, identified by its source file, root name, full
trace ID and occurrence number for that identity, so repeated IDs or file arguments
remain distinct and reordering unrelated files preserves their case names. Each
file is checked independently; traces split across files are not combined.
A run with findings fails; its failure includes every
check ID, title and evidence span IDs. Finding parameters are omitted because they
can contain captured inputs and errors. A clean run passes the
selected applicable rules only; this means no findings, not proof that every rule
had sufficient evidence. Model-based questions are not evaluated. Invalid
input or configuration produces error test cases. Exit codes remain 0 (clean),
1 (findings), and 2 (input/configuration error). A fatal input error aborts checking
and reports that error rather than partial results.

The repository's [CI workflow](https://github.com/neatlogs/neatroots/blob/main/.github/workflows/ci.yml) runs the bundled saved
trace through the built CLI's `secret-in-output` rule and uploads `agent-checks.xml`
with `if: always()`, so the report is retained even when the check step fails.
Replace the sample path with
your agent's exported traces, select your rules (omit `--only` for all rules), and
configure your CI test-results viewer to ingest the JUnit file.
Reports still contain paths, names, check titles and error diagnostics; they are
not redacted diagnostic bundles. Uploading them is an explicit
choice to share that data with your CI provider.

## Rules

Code, no model, every span.

```yaml
id: repeated-tool-call
kind: rule
title: Same tool called repeatedly with identical arguments
rule:
  type: repeat            # repeat | errors | count | slow | threshold | match | requires_before | unrecovered_error | run_end
  span: { type: [tool, mcp_tool] }
  same: [tool, input]
  at_least: 3
guidance: >-
  You have called {tool} {count} times with the same arguments ({args}) ...
action: flag              # or halt (your own rules only)
```

| type | Fires when |
| --- | --- |
| `repeat` | `at_least` matching spans share the `same` fields; resolves when the next call differs |
| `errors` | `consecutive` matching spans failed in a row |
| `count` | the run has `at_least` matching spans |
| `slow` | a matching span took at least `at_least_ms` milliseconds (one slow tool call, not the whole run; use `threshold` with `duration_ms` for the run) |
| `threshold` | a run metric (`total_tokens`, `llm_calls`, `duration_ms`, …) reaches `at_least` |
| `match` | a regex matches a span's `input`, `output`, `error` or `name`; an MCP tool result's `content[].text` items are read like plain output too |
| `requires_before` | a `span` call has no earlier successful `requires` call in the same run, for example a refund with no order lookup. Spans can arrive out of order, so during a run it waits 250 ms for a late `requires` span before it raises (or halts), and a finding resolves if the earlier call turns up later |
| `unrecovered_error` | at run end, the last call of a tool failed (no later success of that tool) and the run still produced a final answer that does not say anything failed (a words check, so it is a hint, not proof) |
| `run_end` | the run ended with `error`, `no_output` or `interrupted` |

## Questions

Answered by the decision model with a probability. Yes/no questions are phrased as failures, so a
high probability always means a problem.

```yaml
id: refund-without-ownership
kind: yes_no              # yes_no | choice | score
scope: trace              # span | trace | session
ask: Did the agent issue a refund without first confirming the customer owns the order?
evidence:
  spans: { type: tool, name: [lookup_order, issue_refund] }
  fields: [input, output, status]
  last: 12
  final_output: false
when: live                # live (as spans arrive, and at run end) | end
flag_at: 0.8
guidance: Confirm the customer owns the order before issuing a refund.
applies_to: { workflow: refund-agent }
group: refunds            # optional: checks in one group show as one problem per run
```

`choice` questions take `options` (label → description) and `flag_on`; `score` questions take
`levels` and `flag_at_level`. Score levels are numbered from zero, so `flag_at_level` must be
between `0` and `levels.length - 1`. Fractional thresholds in that range are allowed: the score
is the expected level, not necessarily a whole number.

### Make sure a question can see what it asks about

- `scope: span` judges one call at a time: right for "Did this tool call pass a negative amount?".
  It also sees the tool calls made earlier in the run, so a rule such as "plan before you search" is
  judged against what already happened, and it raises at most one finding per run (later calls that
  show the same problem join it).
- `scope: trace` sees the run's spans in order: right whenever a question relates two things, such
  as a tool's result and what the agent said next.
- A question about the agent's answer ("claims", "says", "reports", "the final response") needs
  `scope: trace` and `evidence.final_output: true`. `neatroots checks validate`, the app's check
  editor and the MCP check tools warn when a check asks about the answer but can't see it; a check
  drafted from a plain-language concern is given that evidence automatically.
- Preview a new check on at least one run that has the problem and one that doesn't.

## Where questions come from

- The **question library**: ignored tool errors, repeating without progress, answers that contradict
  tools, system-prompt violations, unfinished tasks, following instructions found in tool content,
  personal data in output, wrong tool or arguments. Four run on every agent that uses tools,
  whatever the planner picks: ignored tool errors, answers that contradict tools, following
  instructions found in tool content, and personal data in the answer.
- The **planner**: on a workflow's first run the local LLM reads the system prompt, first user message
  and tools, picks 3–8 library questions, fills in parameters, and writes new questions only for gaps.
  Plans are cached per workflow and redone when new tools appear.
- **You**: describe a concern in the app (Checks → New check) and the LLM drafts the question; preview
  it on recent runs before saving.
- **Coding agents**: `create_check` and `preview_check` over MCP.

## Findings

A finding is raised when a rule fires or a probability crosses the line. It becomes **active** when a
note reaches the agent, **resolved** when a later check of the same question falls below the line, and
**dismissed** when you disagree. A model error or timeout records the check as **not checked**; it never
counts as a pass. Dismissals feed each check's precision; noisy checks are flagged for retirement.

Before a question raises a finding, the LLM takes a second look: it must quote the words in the run
that show the problem, the quote must really be there, and it must still hold given what the run did
earlier. The run page shows that quote. When an LLM answered, the run page says "Very likely (LLM
judgment)" rather than a percentage, and its probability is capped at 90%, because an LLM's confidence
in its own answer isn't calibrated.

Checks that describe one incident share a `group` (the library groups `loop`: repeated calls, error
streaks, repeating without progress, runaway loops; `ending`: failed runs, no answer, unfinished tasks;
`tool-result`: ignored tool errors and answers that contradict the tools). Their findings in a run show
as one problem, headed by the most specific one, and count once.

A check you dismiss 3 times in a project goes **quiet** there: its findings are still recorded on the
run page, but no longer count, send notes or appear on Home. Reopen one to count it again.

## Which model answers

With `classifier.backend: auto`: Jev cloud when you turned it on; otherwise the local LLM. Every LLM
answer is also put to Laya in the background, and neatroots records whether Laya agreed. Once Laya agrees
on at least 90% of 30 answers for a question, that question goes to Laya first (about 100 ms instead of
seconds). With no local LLM, Laya answers everything. Settings → Models shows the agreement per question.

## Cost control

When the local LLM stands in for the decision model, span-level questions are asked only about the
newest waiting span (at most four per check per run), identical questions are answered from a cache,
and note-writing jumps the LLM queue. With Laya or Jev every span is asked.
