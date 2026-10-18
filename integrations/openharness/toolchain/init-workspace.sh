#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "miss node (Node 22+ is required)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm (required to install the pinned instrumentation)" >&2; exit 1; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/init-workspace.mjs"
