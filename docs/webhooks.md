# Outgoing webhooks

Webhooks are off unless explicitly configured. No trace content is sent by default.

Use local CLI commands to configure a destination:

    neatroots webhook add https://hooks.example/secret-path --events halt,finding --format json
    neatroots webhook list
    neatroots webhook test http://127.0.0.1:8080/test --format discord

The test command sends a fixed test notification to exactly the supplied destination. It does
not enable that destination. Do not use a production endpoint unless you intend to notify it.
URLs passed on the command line may be retained by your shell history.

Equivalent config.yaml:

    webhooks:
      - url: https://hooks.example/secret-path
        events: [halt, finding]
        format: json

Formats are json, slack and discord. URLs must be HTTP(S), without userinfo or fragments;
path/query credentials are supported and treated as private. Up to 16 unique destinations are
allowed. Duplicate destinations/events and unknown fields/formats/events are rejected. Invalid
hand-edited webhook configuration fails closed (no delivery). Configuration saves use private
0600 permissions on POSIX; Windows access control remains the operator's responsibility.

CLI add updates the running instance through the existing local settings endpoint, or saves
configuration for the next start. Editing YAML directly requires a restart. In-process callers
can mutate config and call Roots.saveConfig(), or emit settings after a change. The settings
endpoint accepts a write-only webhooks array; status exposes counters, never destinations.
Set webhooks: [] (or submit that empty array through settings) to disable delivery. List output
hides every path and query, including secret tokens.

## Events and privacy

A finding notification records the first observed raised/active state per finding identity,
per destination. Later evidence, triage or raised-to-active updates are not new alerts.
Resolved/dismissed/quiet/failed findings are ignored. This is not a critical-only filter:
selecting finding enables all raised/active findings.

A halt notification records a pending halt instruction as queued, and a subsequent claim by
the steering hook as delivered. Neither means the agent actually stopped. Non-halt notes,
expired, superseded and blocked notes are not delivered. Expiration cancels unsent/inflight
notifications for that halt identity; an already received notification cannot be recalled.
Notifications describe observed events, not a continuously current run state.

JSON contains only event/state and permitted trace, finding, note and check identifiers.
No titles, note text, prompts, outputs, finding details, parameters, model responses or destination
URLs are copied. Identifiers outside the bounded identifier syntax are omitted (invalid primary
identity prevents notification). Slack uses plain text with mrkdwn disabled; Discord disables
mentions. No remote response bodies or URL-bearing network errors are logged.

## Delivery boundaries

Delivery is asynchronous and best effort, not durable or exactly once. Bus listeners project a
small payload and enqueue work; they never await network delivery. This still has nonzero CPU
overhead. A queue holds at most 128 waiting jobs with two in flight. Overflow drops new jobs and
increments dropped; status reports accepted, sent, failed, dropped, retried and cancelled counts,
plus pending/in_flight. Check these counters when notifications are missing.

Each request has a five-second deadline. At most three attempts are made for network failures,
timeouts, HTTP429 and5xx, with250ms then500ms backoff. Other HTTP failures (including redirects)
are permanent failures. Redirects are never followed; response bodies are discarded. Retried
requests can be received more than once: consumers should deduplicate by event/identity/state.

At most4096 recent per-destination event identities are retained; after oldest-entry eviction
or restart, an old event may notify again. Configuration changes cancel queued/inflight requests
and retry timers, clear deduplication, and detach the old event handlers. Disabling or closing
Roots does the same. Cancellation cannot undo a request already received remotely. Process
crashes lose waiting notifications. No remote service account or Slack/Discord-specific API
integration is used.
