# samples

Eight scripted support-agent scenarios: six failures and two healthy controls.
Failures cover a lookup loop on a 404, an ignored tool error, a prompt injection in tool output, a personal-data
leak, a contradiction, and a leaked secret. The healthy controls are `happy` and `long-request`.

```bash
uv run run_samples.py                 # all of them
uv run run_samples.py injection happy # some of them
uv run score.py                       # once checks finish: what each sample raised vs expected.json
```
