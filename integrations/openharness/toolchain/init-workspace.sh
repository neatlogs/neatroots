#!/bin/sh
# Runs once, in a fresh workspace (cwd = the workspace), after the template was copied. Harness sets
# HARNESS_WORKSPACE and HARNESS_DSH_DIR.
#
# Instrumentation prerequisite: the agent's LLM calls must be traced. This installs the Neatlogs
# TypeScript SDK and registers its opencode plugin (NeatlogsOpencodePlugin), which turns each
# opencode turn into a neatroots trace. The export uses NEATLOGS_ENDPOINT / NEATLOGS_API_KEY,
# which the harness sets in agent.env (same-machine neatroots by default).
set -e
cd "${HARNESS_WORKSPACE:-.}"
if command -v npm >/dev/null 2>&1; then
  npm install neatlogs --no-audit --no-fund >/dev/null 2>&1 || echo "warn: npm install neatlogs failed; runs will not be traced"
  mkdir -p .opencode/plugin
  printf "export { NeatlogsOpencodePlugin as default } from 'neatlogs/opencode'\n" > .opencode/plugin/neatlogs.ts
  echo "installed the neatlogs opencode plugin (runs are traced to ${NEATLOGS_ENDPOINT:-the Neatlogs endpoint})"
else
  echo "warn: npm not found; install the neatlogs SDK to have runs traced"
fi
printf 'initialized by %s\n' "${HARNESS_DSH:-?}" > .harness-initialized
