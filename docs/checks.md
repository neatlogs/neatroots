# Checks

A check is anything neatroots watches for. Checks are YAML, loaded from (later wins on the same id):

1. the shipped library (`packages/neatroots/library/`),
2. `~/.neatroots/checks/`,
3. each project's `.neatroots/checks/` registered with `neatroots init`,
4. questions the planner or a coding agent wrote (kept in the database until you save them).

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
action: flag              # or halt (your own rules only; needs steering on for the project)
```

| type | Fires when |
| --- | --- |
| `repeat` | `at_least` matching spans share the `same` fields; resolves when the next call differs |
| `errors` | `consecutive` matching spans failed in a row |
| `count` | the run has `at_least` matching spans |
| `slow` | a matching span took at least `at_least_ms` milliseconds (one slow tool call, not the whole run; use `threshold` with `duration_ms` for the run) |
| `threshold` | a run metric (`total_tokens`, `llm_calls`, `duration_ms`, …) reaches `at_least` |
| `match` | a regex matches a span's `input`, `output`, `error` or `name`; an MCP tool result's `content[].text` items are read like plain output too (the first 200,000 characters in all). A pattern that doesn't compile, or that nests repeats like `(a+)+` and could freeze neatroots, is rejected when the check is saved. That check catches the common slow shape, not every one, so patterns from checks you or a coding agent write also run under a 50 ms limit per span: a pattern that takes longer, such as a repeat over overlapping alternatives like `(a\|aa)+`, is skipped with a warning in the log until neatroots restarts |
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
- `scope: session` sees the conversation's runs so far, oldest first: right for cross-turn problems
  such as the agent contradicting a constraint the user set in an earlier turn. It is judged at each
  run's end, and the finding pins to the run where the problem became visible, with evidence from
  that run. It reads at most the 25 earlier finished runs of the session (the newest ones), and runs
  still in progress are skipped. It can also see the run's final answer with `evidence.final_output: true`.
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
- **Coding agents**: `create_check` and `preview_check` over MCP. A coding agent can save `flag` rules and
  questions, but not halt rules: it can't create one, turn a check into one, or change yours. Switch a
  rule to `action: halt` yourself in the app or CLI.

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
