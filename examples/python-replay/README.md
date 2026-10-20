# python-replay

An agent that can be re-run from the neatroots app. Two lines make that work:

- `neatroots_steer.replay_input(default)` returns the replay's input when neatroots re-runs the agent, and `default` otherwise.
- `neatroots_steer.wrap(client)` applies a replay's model and system prompt to the LLM calls.

```bash
uv run agent.py                                                   # one run
neatroots rerun add example-replay "uv run -q agent.py" --cwd .   # tell neatroots how to start it
```

Open the run, choose **Replay**, change the input or the model, and **Re-run agent**. The new run is
linked to the original and checked like any other. Or from a terminal:
`neatroots replay <trace-id> --input "a different question" --model small-model`.
