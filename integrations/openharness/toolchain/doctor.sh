#!/bin/sh
set -eu
for tool in sh node npm opencode curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "miss $tool"; exit 1; }
done
base=$(printenv NEATLOGS_ENDPOINT || true)
if [ -z "$base" ]; then base=http://localhost:4100; fi
node --input-type=module -e 'const u=new URL(process.argv[1]); if(!["http:","https:"].includes(u.protocol)||!["localhost","127.0.0.1","[::1]"].includes(u.hostname)||u.username||u.password||u.search||u.hash||!["","/"].includes(u.pathname)) process.exit(1)' "$base" ||
  { echo "miss loopback NEATLOGS_ENDPOINT"; exit 1; }
base=${base%/}
status=$(curl --connect-timeout 2 --max-time 5 --fail --silent --output /dev/null --write-out "%{http_code}" "$base/health") && [ "$status" = 200 ] ||
  { echo "miss neatroots health (start the same-machine instance; deadline 5 seconds)"; exit 1; }
echo "ok machine prerequisites and neatroots health (not proof of trace/check delivery)"
workspace=$(printenv HARNESS_WORKSPACE || true)
if [ -n "$workspace" ]; then
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  node "$here/check-workspace.mjs" "$workspace" >/dev/null 2>&1 ||
    { echo "miss workspace instrumentation (retry toolchain/init-workspace.sh)"; exit 1; }
  echo "ok workspace SDK import"
else
  echo "info workspace instrumentation is checked during workspace initialization"
fi
