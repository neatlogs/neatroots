#!/bin/sh
# neatroots installer.
#
#   curl -fsSL https://raw.githubusercontent.com/neatlogs/neatroots/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --service      # also start neatroots at login
#
# Downloads the prebuilt release (one bundle for macOS and Linux) into ~/.neatroots/app and puts
# `neatroots` in ~/.local/bin. Uses your Node.js if it is 22 or newer, otherwise downloads a private
# copy into ~/.neatroots/node. No sudo, no git, no build. Your runs and settings live in ~/.neatroots
# and are kept on update.
#
# Options (flags or environment variables):
#   --service            start neatroots in the background now and at login   (NEATROOTS_SERVICE=1)
#   --version <tag>      release to install, e.g. v0.2.0                 (NEATROOTS_VERSION, default latest)
#   --connect            connect the coding agents found here, no prompt (NEATROOTS_CONNECT=1; 0 to skip)
#   --no-connect         don't offer to connect coding agents
#   --laya, --no-laya    download Laya (local decision model, ~1.4 GB) or skip it, no prompt (NEATROOTS_LAYA=yes|no)
#   --dir <path>         install directory                                (NEATROOTS_INSTALL_DIR, default ~/.neatroots)
#   --bin-dir <path>     where the `neatroots` command goes                (NEATROOTS_BIN_DIR, default ~/.local/bin)
#   --no-modify-path     do not add the bin dir to your shell profile     (NEATROOTS_NO_MODIFY_PATH=1)
#   --bundle <file>      install from a downloaded neatroots.tar.gz        (NEATROOTS_BUNDLE)
#   --from-source        clone and build instead of downloading           (NEATROOTS_FROM_SOURCE=1)
#   --ref <ref>          branch or tag to build (implies --from-source)   (NEATROOTS_REF, default main)
#   --uninstall          remove the command, service and app (keeps your data)
#
# The whole script is a function called on the last line, so a partial download runs nothing.

set -eu

main() {
  GH_REPO="${NEATROOTS_GITHUB_REPO:-neatlogs/neatroots}"
  REPO="${NEATROOTS_REPO:-https://github.com/$GH_REPO.git}"
  REF="${NEATROOTS_REF:-}"
  VERSION="${NEATROOTS_VERSION:-latest}"
  BUNDLE="${NEATROOTS_BUNDLE:-}"
  FROM_SOURCE="${NEATROOTS_FROM_SOURCE:-0}"
  DIR="${NEATROOTS_INSTALL_DIR:-$HOME/.neatroots}"
  BIN_DIR="${NEATROOTS_BIN_DIR:-$HOME/.local/bin}"
  SERVICE="${NEATROOTS_SERVICE:-0}"
  CONNECT="${NEATROOTS_CONNECT:-ask}"
  LAYA="${NEATROOTS_LAYA:-ask}"
  NO_MODIFY_PATH="${NEATROOTS_NO_MODIFY_PATH:-0}"
  UPDATE="${NEATROOTS_UPDATE:-0}"
  UNINSTALL=0
  NODE_VERSION="24.14.1"
  PNPM_VERSION="10.33.0"

  while [ $# -gt 0 ]; do
    case "$1" in
      --service) SERVICE=1 ;;
      --version) VERSION="$2"; shift ;;
      --connect) CONNECT=1 ;;
      --no-connect) CONNECT=0 ;;
      --laya) LAYA=yes ;;
      --no-laya) LAYA=no ;;
      --dir) DIR="$2"; shift ;;
      --bin-dir) BIN_DIR="$2"; shift ;;
      --no-modify-path) NO_MODIFY_PATH=1 ;;
      --bundle) BUNDLE="$2"; shift ;;
      --from-source) FROM_SOURCE=1 ;;
      --ref) REF="$2"; FROM_SOURCE=1; shift ;;
      --repo) REPO="$2"; FROM_SOURCE=1; shift ;;
      --uninstall) UNINSTALL=1 ;;
      -h|--help) sed -n '2,27p' "$0" 2>/dev/null || true; exit 0 ;;
      *) fail "unknown option: $1" ;;
    esac
    shift
  done

  SRC="${NEATROOTS_SOURCE_DIR:-$DIR/src}"
  APP="$DIR/app"
  LOG="$DIR/install.log"
  [ -n "$REF" ] || REF=main

  if [ "$UNINSTALL" = 1 ]; then uninstall; return; fi

  detect_platform
  need tar
  mkdir -p "$DIR" "$BIN_DIR"
  : >"$LOG"

  # An update keeps the kind of install it found: a source checkout stays one.
  if [ -n "${NEATROOTS_SOURCE_DIR:-}" ]; then FROM_SOURCE=1; fi
  if [ "$UPDATE" = 1 ] && [ ! -f "$APP/.neatroots-bundle" ] && [ -f "$SRC/.neatroots-installed" ]; then FROM_SOURCE=1; fi

  if [ "$UPDATE" = 1 ]; then say "Updating neatroots"; else say "Installing neatroots"; fi
  ensure_node
  if [ "$FROM_SOURCE" = 1 ]; then
    install_from_source
  elif ! install_bundle; then
    if [ -n "$BUNDLE" ] || [ "$VERSION" != latest ]; then fail "could not install the prebuilt bundle (see $LOG)"; fi
    step "No prebuilt release reachable for $GH_REPO; building from source instead"
    install_from_source
  fi
  if [ "$UPDATE" = 1 ]; then
    [ -f "$BIN_DIR/neatroots" ] && write_command
    ok "neatroots updated ($(version))"
    return
  fi
  retire_neatbolt
  write_command
  setup_path
  connect_agents
  choose_laya
  finish
}

# ------------------------------------------------------------------ output

if [ -t 1 ]; then B="$(printf '\033[1m')"; G="$(printf '\033[32m')"; R="$(printf '\033[31m')"; D="$(printf '\033[2m')"; N="$(printf '\033[0m')"; else B=""; G=""; R=""; D=""; N=""; fi
say() { printf '%s\n' "${B}$*${N}"; }
ok() { printf '%s\n' "${G}✓${N} $*"; }
step() { printf '%s\n' "${D}→${N} $*"; }
fail() {
  printf '%s\n' "${R}✗ $*${N}" >&2
  if [ -n "${LOG:-}" ] && [ -s "${LOG:-/nonexistent}" ]; then
    printf '%s\n' "${D}Last lines of $LOG:${N}" >&2
    tail -n 20 "$LOG" >&2
  fi
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Install it and run this again."; }
run() { "$@" >>"$LOG" 2>&1 || fail "failed: $*"; }

# ---------------------------------------------------------------- platform

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    MINGW*|MSYS*|CYGWIN*) fail "Windows is not supported directly. Run this inside WSL." ;;
    *) fail "unsupported system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    *) fail "unsupported CPU: $(uname -m)" ;;
  esac
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

# -------------------------------------------------------------------- node

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  NODE=""
  if [ -n "${NEATROOTS_NODE:-}" ] && [ -x "$NEATROOTS_NODE" ] && [ "$(node_major "$NEATROOTS_NODE")" -ge 22 ]; then
    NODE="$NEATROOTS_NODE"
  elif [ "${NEATROOTS_FORCE_NODE:-0}" != 1 ] && command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 22 ]; then
    NODE="$(command -v node)"
  elif [ -x "$DIR/node/bin/node" ] && [ "$(node_major "$DIR/node/bin/node")" -ge 22 ]; then
    NODE="$DIR/node/bin/node"
  else
    install_node
    NODE="$DIR/node/bin/node"
  fi
  NODE_BIN="$(dirname "$NODE")"
  ok "Node.js $("$NODE" -v) ($NODE)"
}

install_node() {
  need curl
  if [ "$OS" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "this Linux uses musl (e.g. Alpine). Install Node.js 22 or newer yourself and run this again."
  fi
  name="node-v$NODE_VERSION-$OS-$ARCH"
  step "Downloading Node.js $NODE_VERSION (no Node 22+ found)"
  tmp="$(mktemp -d)"
  run curl -fsSL -o "$tmp/$name.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
  run curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  want="$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$(sha256 "$tmp/$name.tar.gz")" = "$want" ] || fail "Node.js download did not match its checksum"
  rm -rf "$DIR/node"
  run tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  mv "$tmp/$name" "$DIR/node"
  rm -rf "$tmp"
}

# ------------------------------------------------------------ prebuilt bundle

# Fetches neatroots.tar.gz and its .sha256 into $1. Public releases come straight from GitHub; while
# the repository is private, the GitHub CLI (gh auth login) is used instead.
download_release() {
  asset="neatroots.tar.gz"
  if [ "$VERSION" = latest ]; then base="https://github.com/$GH_REPO/releases/latest/download"; else base="https://github.com/$GH_REPO/releases/download/$VERSION"; fi
  if command -v curl >/dev/null 2>&1 &&
    curl -fsSL -o "$1/$asset" "$base/$asset" >>"$LOG" 2>&1 &&
    curl -fsSL -o "$1/$asset.sha256" "$base/$asset.sha256" >>"$LOG" 2>&1; then
    return 0
  fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    step "Downloading with the GitHub CLI"
    if [ "$VERSION" = latest ]; then
      gh release download -R "$GH_REPO" -p "$asset" -p "$asset.sha256" -D "$1" --clobber >>"$LOG" 2>&1 && return 0
    else
      gh release download "$VERSION" -R "$GH_REPO" -p "$asset" -p "$asset.sha256" -D "$1" --clobber >>"$LOG" 2>&1 && return 0
    fi
  fi
  return 1
}

install_bundle() {
  tmp="$(mktemp -d)"
  if [ -n "$BUNDLE" ]; then
    [ -f "$BUNDLE" ] || fail "no such file: $BUNDLE"
    step "Installing from $BUNDLE"
    cp "$BUNDLE" "$tmp/neatroots.tar.gz"
    [ -f "$BUNDLE.sha256" ] && cp "$BUNDLE.sha256" "$tmp/neatroots.tar.gz.sha256"
  else
    step "Downloading neatroots ($VERSION)"
    if ! download_release "$tmp"; then rm -rf "$tmp"; return 1; fi
  fi
  if [ -f "$tmp/neatroots.tar.gz.sha256" ]; then
    want="$(cut -d' ' -f1 "$tmp/neatroots.tar.gz.sha256")"
    [ "$(sha256 "$tmp/neatroots.tar.gz")" = "$want" ] || fail "the download did not match its checksum"
  elif [ -z "$BUNDLE" ]; then
    fail "the release has no checksum file"
  fi
  rm -rf "$APP.new"
  mkdir -p "$APP.new"
  run tar -xzf "$tmp/neatroots.tar.gz" -C "$APP.new"
  rm -rf "$tmp"
  [ -f "$APP.new/neatroots/dist/cli.js" ] && [ -f "$APP.new/.neatroots-bundle" ] || fail "the bundle is incomplete"
  "$NODE" "$APP.new/neatroots/dist/cli.js" --version >>"$LOG" 2>&1 || fail "the downloaded neatroots doesn't start with $NODE"
  # Swap in one step, so a failed update leaves the old version working.
  rm -rf "$APP.old"
  [ -d "$APP" ] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"
  CLI="$APP/neatroots/dist/cli.js"
  STEER_PY="$APP/steer/python/neatroots-steer"
  STEER_TS="$APP/steer/ts"
  GUIDE="$APP/docs/getting-started.md"
  EXAMPLES="$APP/examples"
  ok "neatroots $(version) in $APP"
}

# ------------------------------------------------------------ from source

install_from_source() {
  need git
  fetch_source
  build
  CLI="$SRC/packages/neatroots/dist/cli.js"
  STEER_PY="$SRC/python/neatroots-steer"
  STEER_TS="$SRC/packages/steer-ts"
  GUIDE="$SRC/docs/getting-started.md"
  EXAMPLES="$SRC/examples"
}

fetch_source() {
  if [ -f "$SRC/.neatroots-installed" ]; then
    # A checkout this script made: follow the requested branch or tag exactly.
    step "Fetching $REF"
    run git -C "$SRC" fetch --depth 1 origin "$REF"
    run git -C "$SRC" checkout -q -B "$REF" FETCH_HEAD
  elif [ -n "${NEATROOTS_SOURCE_DIR:-}" ]; then
    # Your own checkout: never reset it; fast-forward only when it tracks a remote.
    [ -f "$SRC/pnpm-workspace.yaml" ] || fail "$SRC is not a neatroots checkout"
    if [ "$UPDATE" = 1 ] && git -C "$SRC" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      step "Pulling"
      run git -C "$SRC" pull --ff-only
    fi
  else
    step "Cloning $REPO ($REF)"
    rm -rf "$SRC"
    git clone -q --depth 1 --branch "$REF" "$REPO" "$SRC" >>"$LOG" 2>&1 || fail "could not clone $REPO. If the repository is private, check that git can reach it (gh auth login, or an SSH key)."
    touch "$SRC/.neatroots-installed"
  fi
  ok "Source $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo local) in $SRC"
}

pnpm() {
  (cd "$SRC" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" exec --yes --package="pnpm@$PNPM_VERSION" -- pnpm "$@")
}

build() {
  step "Installing dependencies (a minute or two the first time)"
  pnpm install --frozen-lockfile >>"$LOG" 2>&1 || fail "pnpm install failed"
  step "Building"
  pnpm build >>"$LOG" 2>&1 || fail "build failed"
  [ -f "$SRC/packages/neatroots/dist/cli.js" ] || fail "build did not produce packages/neatroots/dist/cli.js"
  ok "Built"
}

version() { "$NODE" "$CLI" --version 2>/dev/null || echo "?"; }

# ----------------------------------------------------------------- command

write_command() {
  cat >"$BIN_DIR/neatroots" <<EOF
#!/bin/sh
# neatroots (written by install.sh; \`neatroots update\` updates it)
NEATROOTS_WRAPPER="$BIN_DIR/neatroots" exec "$NODE" "$CLI" "\$@"
EOF
  chmod +x "$BIN_DIR/neatroots"
  ok "Command: $BIN_DIR/neatroots ($(version))"
}

setup_path() {
  case ":$PATH:" in *":$BIN_DIR:"*) return ;; esac
  line="export PATH=\"$BIN_DIR:\$PATH\""
  if [ "$NO_MODIFY_PATH" = 1 ]; then
    PATH_NOTE="Add $BIN_DIR to your PATH:  $line"
    return
  fi
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    */fish) rc="" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -z "$rc" ]; then
    PATH_NOTE="Add $BIN_DIR to your PATH:  fish_add_path $BIN_DIR"
    return
  fi
  if ! grep -qs "# neatroots" "$rc"; then
    printf '\n%s  # neatroots\n' "$line" >>"$rc"
    ok "Added $BIN_DIR to PATH in $rc"
  fi
  PATH_NOTE="Open a new terminal (or run: source $rc) so \`neatroots\` is on your PATH."
}

# ------------------------------------------------------------ coding agents

# Offers to register neatroots' MCP server with the coding agents on this machine (Claude Code, Codex,
# Cursor, …). Asks on the terminal even under `curl | sh`; never edits anything without a yes or
# --connect.
connect_agents() {
  [ "$CONNECT" = 0 ] && return
  found="$("$BIN_DIR/neatroots" connect --list-detected 2>/dev/null || true)"
  if [ -z "$found" ]; then return; fi
  if [ "$CONNECT" = 1 ]; then
    "$BIN_DIR/neatroots" connect --detected --yes || true
    return
  fi
  if [ -t 1 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    echo
    printf '%s' "Connect neatroots to $found, so they can read its findings over MCP? [Y/n] "
    ans=""
    read -r ans </dev/tty || ans=n
    case "$ans" in
      ""|y|Y|yes|YES) "$BIN_DIR/neatroots" connect --detected --yes || true ;;
      *) CONNECT_NOTE="Connect coding agents later: neatroots connect" ;;
    esac
  else
    CONNECT_NOTE="Connect your coding agents ($found): neatroots connect --detected"
  fi
}

# Laya is a 1.4 GB download, so it's the person's choice; neatroots explains why it wants it.
choose_laya() {
  case "$LAYA" in
    yes|1) "$BIN_DIR/neatroots" laya allow >>"$LOG" 2>&1 && ok "Laya downloads in the background the first time neatroots starts" ; return ;;
    no|0) "$BIN_DIR/neatroots" laya skip >>"$LOG" 2>&1; LAYA_NOTE="Laya skipped. For check answers set up Jev cloud: neatroots jev login && neatroots jev on" ; return ;;
  esac
  # Asks only while Laya isn't installed and hasn't been answered, so updates don't ask again.
  if [ -t 1 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    "$BIN_DIR/neatroots" laya choose </dev/tty || LAYA_NOTE="Choose later: neatroots laya install (local), or neatroots jev login && neatroots jev on (cloud)"
  else
    LAYA_NOTE="$("$BIN_DIR/neatroots" laya choose --no-ask 2>/dev/null || true)"
  fi
}

finish() {
  echo
  if [ "$SERVICE" = 1 ]; then
    "$BIN_DIR/neatroots" service install || true
  fi
  say "neatroots is installed."
  [ -n "${PATH_NOTE:-}" ] && echo "  $PATH_NOTE"
  echo
  if [ "$SERVICE" != 1 ]; then
    echo "  Start it:            neatroots start            (or neatroots service install to run it at login)"
  fi
  echo "  Open the app:        http://localhost:4100"
  echo "  Point your agent:    export NEATLOGS_ENDPOINT=http://localhost:4100 NEATLOGS_API_KEY=neatroots-local"
  [ -n "${CONNECT_NOTE:-}" ] && echo "  ${CONNECT_NOTE}"
  [ -n "${LAYA_NOTE:-}" ] && echo "  ${LAYA_NOTE}"
  echo "  Check everything:    neatroots doctor"
  echo "  No agent yet?        $EXAMPLES/README.md  (15 examples; neatroots mock-llm means no API keys)"
  echo
  if ! command -v ollama >/dev/null 2>&1; then
    echo "  ${D}No Ollama found. Rules work without it; for questions and explanations install a local model"
    echo "  (https://ollama.com, then: ollama pull qwen3:8b) or use a hosted one: neatroots llm login anthropic${N}"
  fi
  echo "  ${D}Steering hooks: pip install \"$STEER_PY\"  ·  npm install \"$STEER_TS\"${N}"
  echo "  ${D}Guide: $GUIDE${N}"
}

# ------------------------------------------------- from Neatlogs Bolt (v0.1)

# Before the rename neatroots was `neatbolt`. Its background service would hold port 4100, so stop
# it (and run neatroots at login instead), and remove its command and app code. Its runs, settings
# and Laya stay in ~/.neatbolt, where neatroots keeps using them.
retire_neatbolt() {
  had_service=0
  if [ "$OS" = darwin ]; then
    plist="$HOME/Library/LaunchAgents/com.neatlogs.neatbolt.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)/com.neatlogs.neatbolt" >/dev/null 2>&1 || true
      rm -f "$plist"
      had_service=1
    fi
  elif [ -f "$HOME/.config/systemd/user/neatbolt.service" ]; then
    systemctl --user disable --now neatbolt.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/neatbolt.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    had_service=1
  fi
  removed=""
  if [ -f "$BIN_DIR/neatbolt" ] && grep -q "neatbolt" "$BIN_DIR/neatbolt" 2>/dev/null; then
    rm -f "$BIN_DIR/neatbolt"
    removed="the neatbolt command"
  fi
  if [ -f "$HOME/.neatbolt/app/.neatbolt-bundle" ]; then
    rm -rf "$HOME/.neatbolt/app" "$HOME/.neatbolt/app.old" "$HOME/.neatbolt/node"
    removed="${removed:+$removed and }its app"
  fi
  [ -n "$removed" ] && ok "Replaced Neatlogs Bolt: removed $removed (your runs and settings stay in ~/.neatbolt)"
  if [ "$had_service" = 1 ]; then
    # Give the old process a moment to let go of its port before neatroots' service starts.
    i=0
    while [ $i -lt 10 ] && curl -sf -m 1 http://127.0.0.1:4100/api/status >/dev/null 2>&1; do sleep 1; i=$((i + 1)); done
    ok "Stopped the neatbolt background service; neatroots will run at login instead"
    SERVICE=1
  fi
  return 0
}

# --------------------------------------------------------------- uninstall

uninstall() {
  if [ -x "$BIN_DIR/neatroots" ]; then
    "$BIN_DIR/neatroots" service uninstall >/dev/null 2>&1 || true
    # Connected coding agents would point at a command that no longer exists.
    "$BIN_DIR/neatroots" connect --remove --detected 2>/dev/null || true
  fi
  rm -f "$BIN_DIR/neatroots"
  rm -rf "$DIR/app" "$DIR/app.new" "$DIR/app.old" "$DIR/src" "$DIR/node" "$DIR/install.log"
  ok "Removed the neatroots command, background service, app and private Node.js."
  echo "  Your runs, settings and Laya are still in $DIR. Delete that folder to remove them too."
  echo "  Stored API keys are in the macOS Keychain under \"neatroots\" (Keychain Access to remove)."
}

main "$@"
