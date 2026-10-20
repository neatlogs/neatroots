---
name: neatroots-write-check
description: Turn a bug or concern the user describes into a neatroots check, preview how often it fires on recent runs, and save it. Use when the user wants neatroots to watch for a specific failure from now on.
---

# Write a neatroots check

1. Restate the failure as a yes/no question phrased as a failure ("Did the agent … without …?"), so
   that yes means a problem. Decide whether one span shows it (`scope: span`) or it needs the run
   (`scope: trace`).
2. Draft it: `create_check` with `concern` (the local LLM writes it) and `save: false`, or write the
   YAML yourself (see `docs/checks.md`). Prefer a **rule** when the failure is mechanical (same call
   repeated, an error streak, a regex on output): rules are exact and free.
3. Preview: `preview_check` with the draft. A good check fires on the runs that have the bug and few
   others. If it fires everywhere, make the question more specific; if nowhere, check the evidence
   selector (span types and names).
4. Show the user the YAML and the hit rate, then save: `create_check` with `save: true` (to
   `~/.neatroots/checks`) or `dir` set to the repo's `.neatroots/checks` so the team gets it too.
5. Add a short `guidance` line if steering is on, so the agent gets a useful note when it fires.
