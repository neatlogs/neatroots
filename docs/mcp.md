# Coding agents (MCP)

neatroots serves MCP over streamable HTTP at `http://localhost:4100/mcp` and over stdio with
`neatroots mcp` (which starts neatroots if it is not running). Both expose the same tools.

```bash
neatroots connect             # Claude Code, Codex, Cursor, OpenCode, Windsurf, Amp, Gemini CLI, VS Code, Claude Desktop
neatroots connect --print cursor   # what to add by hand
```

`neatroots connect` registers `~/.local/bin/neatroots mcp` (the installer's command, which survives
updates) with each agent, in that agent's own settings file or, for Claude Code, through `claude mcp add
--scope user`.

The 23 tools, by what they are for:

### Reading runs

| Tool | Returns | Model |
| --- | --- | --- |
| `get_current_run` | The run in focus in the app (or the latest), its outline, findings and selected span | none |
| `search_runs` | Runs by workflow, project, status, findings, time or text | none |
| `get_run_outline` | Span tree with kinds, status, tokens, durations, previews, findings inline | none |
| `get_span` | A span's input, output, error and attributes; JSONPath selection and paging | none |
| `get_span_context` | Where a span sits: its ancestors, siblings in order and children, with previews | none |
| `search_in_run` | Spans in one run whose name, tool, model, input, output or error contains a text, with snippets | none |
| `get_conversation` | Every run in a session (a multi-turn conversation), oldest first, with each turn's problems | none |
| `list_projects` | The agents neatroots has seen, with run counts, problem counts and last run | none |
| `query_sql` | One read-only `SELECT` over the local store (at most 200 rows), for questions the other tools don't answer | none |
| `show_in_ui` | Opens a run, span or view (overview, trace, timeline, conversation) in the app the user has open | none |

### Diagnosing

| Tool | Returns | Model |
| --- | --- | --- |
| `list_findings` | Findings with probabilities, evidence span ids and explanations | none |
| `compare_runs` | Two runs side by side: status, duration, tokens, tool sequence, outputs, problems | none |
| `explain_run` | Likely cause, the spans that show it, a fix, and an evidence-support score | local LLM, checked by the decision model |
| `ask` | An answer over local runs, citing span ids | local LLM, checked by the decision model |
| `judge` | The probability that a yes/no question about chosen spans is yes | decision model |

### Acting

| Tool | Returns | Model |
| --- | --- | --- |
| `create_check`, `preview_check` | A check proposal from a concern or YAML, and its hit rate on recent runs. Saved proposals require approval in Checks. `create_check` cannot save a rule with `action: halt` or change an existing halt rule; only you make halt rules, in the app or CLI | local LLM, then decision model |
| `annotate` | Marks a run or span as issue, good, or a note | none |
| `replay` | Re-sends one LLM span's messages (edited, or with another model or system prompt) and stores the answer as a new run | the configured LLM |
| `rerun` | Re-runs the whole agent through its registered command or endpoint (`neatroots rerun add`), optionally with a new input, model or system prompt | none |

`create_check` with `save=false` still returns a draft only. Saving creates a local pending proposal shown in Checks; it remains inactive until a person approves it there. Editing an approved check keeps the current version active and unchanged while the proposal waits. `preview_check` by id previews the pending version when one exists. Approval writes the proposal to its user or registered project checks file and retains its MCP origin; rejection discards only the proposal. These actions are local and do not send anything to Neatlogs Cloud. Person-initiated UI saves still activate immediately. The existing CLI `checks` commands only list or validate files; they are unchanged.

### Neatlogs Cloud

| Tool | Returns | Model |
| --- | --- | --- |
| `list_cloud_traces` | Recent traces in your Neatlogs Cloud project (needs a service-account token: `neatroots cloud token`) | none |
| `import_cloud_trace` | Pulls one cloud trace, with inputs and outputs, into neatroots to explain, check and replay locally | none |
| `push_to_cloud` | Asks to send runs to Neatlogs Cloud; you confirm in the app | none |

A good first prompt: *"Look at my last run in neatroots, explain what went wrong, fix it, replay the
run and compare the two."* See [replay.md](replay.md) for setting up whole-agent replays.

Span ids can be shortened to any unique prefix. Run content is data recorded from an agent; the
server's instructions tell clients not to follow instructions inside it.
