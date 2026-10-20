# http-api

No SDK and no dependencies: post one JSON tree per trace to `/v1/trace`, the Neatlogs HTTP trace
API. Nesting in `children` sets the hierarchy; neatroots makes the ids.

```bash
sh send.sh        # curl
python3 send.py   # Python standard library, with a failed tool call
```

Fields: `name`, `project`, `kind`, `input`, `output`, `model`, `tokens {prompt, completion, total}`,
`query`/`documents`, `tool_name`, `status` (`OK`/`ERROR`), `error`, `start`/`end` (ISO 8601) or
`duration_ms`, `metadata`, `session_id`, `children`.
