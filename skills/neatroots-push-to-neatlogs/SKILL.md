---
name: neatroots-push-to-neatlogs
description: Send the runs under discussion from neatroots to Neatlogs Cloud so the team can see them. Use when the user wants to share a run, keep history, or hand a run to teammates.
---

# Push runs to Neatlogs Cloud

1. Identify the runs (trace ids from `get_current_run`, `search_runs`, or the conversation).
2. Call `push_to_cloud` with `trace_ids`. Nothing is sent yet: neatroots shows the user a banner with the
   span count and what will be redacted, and the user confirms in the app.
3. Tell the user to confirm in neatroots (http://localhost:4100). If they have no API key yet, they add it
   in Settings → Neatlogs Cloud or with `neatroots cloud login`; never ask them to paste it into the chat.
4. Call `push_to_cloud` with the returned `push_id` to check the result (`sent`, `failed`, `declined`; `sending` while it goes out).
   On success, point the user to the run in Neatlogs Cloud (the app URL is in the result).
