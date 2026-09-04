#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────
#  ClawGod Installer
#
#  Downloads Claude Code from npm, applies patches, replaces claude command
#
#  用法:
#    curl -fsSL https://raw.githubusercontent.com/0Chencc/clawgod/main/install.sh | bash
#    # 或
#    bash install.sh [--version 2.1.89] [--no-upgrade]
# ─────────────────────────────────────────────────────────

CLAWGOD_DIR="$HOME/.clawgod"
BIN_DIR="$HOME/.local/bin"
VERSION="${CLAWGOD_VERSION:-latest}"
NO_UPGRADE="${CLAWGOD_NO_UPGRADE:-}"
LEAN_OFF="${CLAWGOD_LEAN_OFF:-}"
LEAN_ON="${CLAWGOD_LEAN_ON:-}"
LEAN_MAX="${CLAWGOD_LEAN_MAX:-}"
CLAWGOD_SELF_VERSION="0.0.0-dev"  # injected by release workflow from git tag

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --version) VERSION="$2"; shift 2 ;;
    --no-upgrade) NO_UPGRADE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --lean-off) LEAN_OFF=1; shift ;;
    --lean-on) LEAN_ON=1; shift ;;
    --lean-max) LEAN_MAX=1; shift ;;
    *) shift ;;
  esac
done

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${RED}✗${NC} $1"; }
dim()   { echo -e "  ${DIM}$1${NC}"; }

echo ""
echo -e "${BOLD}  ClawGod Installer${NC}"
echo ""

# ─── Uninstall ─────────────────────────────────────────

if [ "$UNINSTALL" = "1" ]; then
  CLAUDE_BIN=$(command -v claude 2>/dev/null || true)
  for DIR in "${CLAUDE_BIN:+$(dirname "$CLAUDE_BIN")}" "$BIN_DIR"; do
    [ -z "$DIR" ] && continue
    if [ -e "$DIR/claude.orig" ]; then
      # Has backup — restore it
      mv "$DIR/claude.orig" "$DIR/claude"
      info "Original claude restored ($DIR/claude)"
    elif [ -f "$DIR/claude" ] && grep -q "clawgod" "$DIR/claude" 2>/dev/null; then
      # Our launcher, no backup — remove it (otherwise it points to deleted cli.js)
      rm -f "$DIR/claude"
      info "Removed ClawGod launcher ($DIR/claude)"
    fi
    # Always remove the explicit clawgod alias if it's ours
    if [ -f "$DIR/clawgod" ] && grep -q "clawgod" "$DIR/clawgod" 2>/dev/null; then
      rm -f "$DIR/clawgod"
      info "Removed ClawGod alias ($DIR/clawgod)"
    fi
  done
  rm -rf "$CLAWGOD_DIR/node_modules" "$CLAWGOD_DIR/vendor" "$CLAWGOD_DIR/bun-runtime" "$CLAWGOD_DIR/cli.original.js" "$CLAWGOD_DIR/cli.original.js.bak" "$CLAWGOD_DIR/cli.original.cjs" "$CLAWGOD_DIR/cli.original.cjs.bak" "$CLAWGOD_DIR/cli.js" "$CLAWGOD_DIR/cli.cjs" "$CLAWGOD_DIR/patch.mjs" "$CLAWGOD_DIR/patch.js" "$CLAWGOD_DIR/extract-natives.mjs" "$CLAWGOD_DIR/post-process.mjs" "$CLAWGOD_DIR/repatch.mjs" "$CLAWGOD_DIR/openai-proxy.cjs" "$CLAWGOD_DIR/feature-gates.cjs" "$CLAWGOD_DIR/clawgod-import" "$CLAWGOD_DIR/.source-version"
  hash -r 2>/dev/null
  info "ClawGod uninstalled"
  echo ""
  warn "  Restart your terminal or run: hash -r"
  echo ""
  exit 0
fi

# ─── Prerequisites ─────────────────────────────────────

if ! command -v node &>/dev/null; then
  warn "Node.js is required (>= 18) for the patcher. Install from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  warn "Node.js >= 18 required (found v$NODE_VERSION)"
  exit 1
fi

# ─── Ensure Bun (runtime that executes the patched cli.js) ─────────────

BUN_BIN=""
if command -v bun &>/dev/null; then
  BUN_BIN=$(command -v bun)
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
else
  dim "Installing Bun (required runtime for v2.1.113+ cli.js) ..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
  BUN_BIN="$HOME/.bun/bin/bun"
  if [ ! -x "$BUN_BIN" ]; then
    warn "Bun installation failed. Install manually: https://bun.sh/install"
    exit 1
  fi
fi
info "Bun: $($BUN_BIN --version)"

# ─── Bun version pre-flight ───────────────────────────────────────────
# Anthropic builds the native binary with Bun's canary channel; stable
# bun.sh trails by one version. Bun < 1.3.14 panics on cli.original.cjs
# with "Expected CommonJS module to have a function wrapper". Refuse
# early — no npm download / no patch / no late sanity surprise.
# Bump MIN_BUN_VERSION when Anthropic moves the embedded Bun forward
# again (track via 'bun upgrade --canary' on a runner + smoke test).

MIN_BUN_VERSION="1.3.14"
BUN_VERSION_RAW=$($BUN_BIN --version 2>/dev/null | head -1)
BUN_VERSION_NUM=$(echo "$BUN_VERSION_RAW" | sed 's/-.*//')
if [ -z "$BUN_VERSION_NUM" ] \
   || [ "$(printf '%s\n%s\n' "$BUN_VERSION_NUM" "$MIN_BUN_VERSION" | sort -V | head -1)" != "$MIN_BUN_VERSION" ]; then
  warn ""
  warn "Bun ${BUN_VERSION_RAW:-<unknown>} is below the required minimum ($MIN_BUN_VERSION)."
  warn ""
  warn "  Anthropic builds claude-code with Bun's canary channel. Older Bun"
  warn "  panics on cli.original.cjs with 'Expected CommonJS module to have"
  warn "  a function wrapper'. This is a hard requirement, not a warning."
  warn ""
  warn "  Upgrade with one of:"
  warn "    bun upgrade --canary               (if installed via curl/install.sh)"
  warn "    brew upgrade bun                   (homebrew)"
  warn "    scoop uninstall bun && \\           (scoop — shim blocks self-replace)"
  warn "      irm https://bun.sh/install.ps1 | iex && bun upgrade --canary"
  warn ""
  warn "  Then re-run this installer."
  exit 1
fi

# ─── ripgrep prerequisite (search/grep tool) ──────────────────────────
# Without rg the Grep tool inside Claude Code fails. Bun-bundled ripgrep
# is only reachable from inside the standalone executable; running the
# extracted cli.js under Bun runtime means we depend on system rg.
# This is a hard prerequisite — refuse to install otherwise.

if ! command -v rg &>/dev/null; then
  warn "ripgrep (rg) is required but not found in PATH."
  warn "  Claude Code's Grep tool will not function without it."
  warn ""
  case "$(uname -s)" in
    Darwin) warn "  Install: brew install ripgrep" ;;
    Linux)  warn "  Install: apt install ripgrep   |   dnf install ripgrep   |   pacman -S ripgrep" ;;
    *)      warn "  Install: https://github.com/BurntSushi/ripgrep#installation" ;;
  esac
  warn ""
  warn "  Re-run this script after installing rg."
  exit 1
fi
info "ripgrep: $(rg --version | head -1)"

# ─── Handle --no-upgrade (skip download, re-patch only) ──────────────
mkdir -p "$CLAWGOD_DIR" "$BIN_DIR"

if [ "$NO_UPGRADE" = "1" ]; then
  if [ ! -f "$CLAWGOD_DIR/cli.original.cjs" ]; then
    warn "--no-upgrade requires an existing installation."
    warn "Run a full install first (without --no-upgrade)."
    exit 1
  fi
  if [ -f "$CLAWGOD_DIR/cli.original.cjs.bak" ]; then
    cp "$CLAWGOD_DIR/cli.original.cjs.bak" "$CLAWGOD_DIR/cli.original.cjs"
    info "Restored clean cli.original.cjs from backup"
  fi
  info "Skipping download (--no-upgrade)"
else

# ─── Locate native Bun binary (cli.js source) ──────────────────────────
# v2.1.113+ ships a Bun standalone executable as the only canonical form.
# We extract cli.js text from this binary, patch it, then run via Bun
# runtime. Source: npm registry (@anthropic-ai/claude-code-<platform>).
# Local binary detection is intentionally skipped — see policy note below.

mkdir -p "$CLAWGOD_DIR" "$BIN_DIR"

NATIVE_BIN=""
NATIVE_BIN_LABEL=""
NATIVE_BIN_TMPDIR=""

# Detection policy: ALWAYS pull from the npm registry @latest.
#
# Earlier versions of this script also probed local `node_modules` roots
# (npm-global, bun-global) before falling back to the registry. That was
# a stale-source trap: once clawgod is installed it patches out
# `claude update`, so users never re-run `npm install -g` / `bun add -g`.
# Both directories freeze at whatever version was on disk the day clawgod
# was first installed, and `claude update` (which is now redirected here)
# would re-detect that frozen binary forever — never reaching the
# registry. See INCIDENT_LOG 2026-04-29 entry. The fix is to skip local
# detection entirely; the npm tarball is ~60-90 MB compressed, fetched
# once per upgrade, and npm's HTTP cache keeps repeats fast.

# Detect platform suffix (used by the npm fetch below)
case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      os="" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)             arch="" ;;
esac
if [ "$os" = "linux" ] && (ldd /bin/ls 2>/dev/null | grep -q musl); then
  PLATFORM="${os}-${arch}-musl"
else
  PLATFORM="${os}-${arch}"
fi

# Pull the Bun standalone binary from the npm registry. Anthropic publishes
# per-platform packages (e.g. claude-code-darwin-arm64); their tarball ships
# the binary directly under package/.
if [ -z "$NATIVE_BIN" ]; then
  if ! command -v npm &>/dev/null; then
    warn "No native Claude Code binary found locally, and npm is not installed."
    warn "  Either install the official binary first:"
    warn "    curl -fsSL https://claude.ai/install.sh | bash"
    warn "  or install npm so we can fetch it from the registry."
    exit 1
  fi
  if [ -z "$os" ] || [ -z "$arch" ]; then
    warn "Unsupported platform: $(uname -s) $(uname -m)"
    exit 1
  fi
  NPM_PKG="@anthropic-ai/claude-code-${PLATFORM}"
  dim "Fetching $NPM_PKG@$VERSION from npm registry ..."
  NATIVE_BIN_TMPDIR=$(mktemp -d)
  if ( cd "$NATIVE_BIN_TMPDIR" && npm pack "$NPM_PKG@$VERSION" --silent >/dev/null 2>&1 ); then
    TARBALL=$(ls "$NATIVE_BIN_TMPDIR"/*.tgz 2>/dev/null | head -1)
    if [ -n "$TARBALL" ]; then
      ( cd "$NATIVE_BIN_TMPDIR" && tar xzf "$TARBALL" )
      cand="$NATIVE_BIN_TMPDIR/package/claude"
      if [ -f "$cand" ]; then
        sz=$(stat -f%z "$cand" 2>/dev/null || stat -c%s "$cand" 2>/dev/null || echo 0)
        if [ "$sz" -gt 10000000 ]; then
          NATIVE_BIN="$cand"
          NATIVE_BIN_LABEL=$(node -e "console.log(require('$NATIVE_BIN_TMPDIR/package/package.json').version)" 2>/dev/null || echo "npm-latest")
        fi
      fi
    fi
  fi
  if [ -z "$NATIVE_BIN" ]; then
    rm -rf "$NATIVE_BIN_TMPDIR"
    warn "Failed to download $NPM_PKG from npm."
    warn "  Install the official Claude Code binary manually:"
    warn "    curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
  fi
  info "Downloaded $NPM_PKG@$NATIVE_BIN_LABEL"
fi

if [ -z "$NATIVE_BIN" ]; then
  warn "Native Claude Code binary not found"
  warn "Install the official binary first:"
  warn "  curl -fsSL https://claude.ai/install.sh | bash"
  warn "Then re-run this script."
  exit 1
fi

# Write extractor to a temp file (used both for cli.js and .node modules)
cat > "$CLAWGOD_DIR/extract-natives.mjs" << 'EXTRACTOR_EOF'
{{CLAWGOD:extract-natives.mjs}}
EXTRACTOR_EOF

# ─── Extract cli.js + native modules from Bun binary ──────────
# Note: extract-natives.mjs and post-process.mjs are kept around (NOT deleted)
# so the wrapper's drift detector can re-run them when the user upgrades
# their native Claude binary.

# Single extractor pass: writes cli.original.js + (v2.1.245+) full chunk graph
# to $CLAWGOD_DIR/bunfs/ and vendor/<name>/<arch>-<os>/<name>.node, plus a
# pathmap.json for post-process path rewriting.
rm -rf "$CLAWGOD_DIR/vendor" "$CLAWGOD_DIR/bunfs" "$CLAWGOD_DIR/pathmap.json" \
  "$CLAWGOD_DIR/cli.original.js" 2>/dev/null

dim "Extracting cli.js + modules from $(echo "$NATIVE_BIN_LABEL") ..."
if ! node "$CLAWGOD_DIR/extract-natives.mjs" "$NATIVE_BIN" "$CLAWGOD_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done; then
  err "Failed to extract from native binary"
  exit 1
fi
[ -f "$CLAWGOD_DIR/cli.original.js" ] || { err "cli.js missing after extraction"; exit 1; }

# ─── Post-process cli.js for Bun runtime ──────────────────────
# 0. Strip leading @bun pragma comments so Bun recognises the CJS wrapper
# 1. Rewrite /$bunfs/root/X.node paths to point at extracted vendor modules
# 2. Rewrite build-time /home/runner/.../*.ts URLs (used by ripgrep,
#    sandbox, computer-use, etc. for asset resolution) to __filename so
#    relative resolutions land near our cli.original.cjs
# 3. Wrap the Bun-cjs IIFE with an actual invocation so `require()` runs it
# 4. Save as .cjs (Bun + CJS module wrapper)

dim "Rewriting bunfs paths and IIFE invocation ..."
cat > "$CLAWGOD_DIR/post-process.mjs" << 'POSTPROC_EOF'
{{CLAWGOD:post-process.mjs}}
POSTPROC_EOF
node "$CLAWGOD_DIR/post-process.mjs" 2>&1 | while IFS= read -r line; do echo "  $line"; done
[ -f "$CLAWGOD_DIR/cli.original.cjs" ] || { err "Post-process failed"; exit 1; }

# Stamp the source version so the wrapper can detect drift on next launch
echo "$NATIVE_BIN_LABEL" > "$CLAWGOD_DIR/.source-version"

# If we pulled the binary from npm into a tmpdir, clean it up now —
# extraction is done, drift detection only consults ~/.local/share/claude/versions/.
if [ -n "$NATIVE_BIN_TMPDIR" ]; then
  rm -rf "$NATIVE_BIN_TMPDIR"
fi

info "cli.original.cjs ready ($NATIVE_BIN_LABEL)"

fi  # end --no-upgrade skip

# ─── Write re-patch helper (used by wrapper on version drift) ─────────

cat > "$CLAWGOD_DIR/repatch.mjs" << 'REPATCH_EOF'
{{CLAWGOD:repatch.mjs}}
REPATCH_EOF
chmod +x "$CLAWGOD_DIR/repatch.mjs"
info "Re-patch helper installed (repatch.mjs)"

# ─── Write OpenAI-compatible proxy ────────────────────────────

cat > "$CLAWGOD_DIR/openai-proxy.cjs" << 'PROXY_EOF'
{{CLAWGOD:openai-proxy.cjs}}
PROXY_EOF
info "OpenAI-compatible proxy created (openai-proxy.cjs)"

# ─── Write patch feature gates ────────────────────────────────

cat > "$CLAWGOD_DIR/feature-gates.cjs" << 'GATES_EOF'
{{CLAWGOD:feature-gates.cjs}}
GATES_EOF
info "Patch feature gates created (feature-gates.cjs)"

# ─── Write wrapper (cli.cjs, runs under Bun) ──────────────────

cat > "$CLAWGOD_DIR/cli.cjs" << 'WRAPPER_EOF'
{{CLAWGOD:cli.cjs}}
WRAPPER_EOF
chmod +x "$CLAWGOD_DIR/cli.cjs"
echo "$CLAWGOD_SELF_VERSION" > "$CLAWGOD_DIR/.clawgod-version"
info "Wrapper created (cli.cjs)"

# ─── Write classifier runtime helper ────────────────────

cat > "$CLAWGOD_DIR/runtime-helpers.cjs" << 'CFG_EOF'
{{CLAWGOD:runtime-helpers.cjs}}
CFG_EOF
info "Classifier runtime helpers created (runtime-helpers.cjs)"

# ─── Write universal patcher ───────────────────────────

cat > "$CLAWGOD_DIR/patch.mjs" << 'PATCHER_EOF'
{{CLAWGOD:patch.mjs}}

PATCHER_EOF
info "Patcher created (patch.mjs)"

# ─── Apply patches ─────────────────────────────────────

dim "Applying patches ..."
node "$CLAWGOD_DIR/patch.mjs" 2>&1 | while IFS= read -r line; do echo "  $line"; done
patch_status=${PIPESTATUS[0]}
if [ "$patch_status" -ne 0 ]; then
  warn "Patching failed (node exit $patch_status). Installation aborted."
  exit "$patch_status"
fi

# ─── Create default configs ───────────────────────────

if [ ! -f "$CLAWGOD_DIR/features.json" ]; then
  cat > "$CLAWGOD_DIR/features.json" << 'FEATURES_EOF'
{{CLAWGOD:features.json}}
FEATURES_EOF
  info "Default features.json created"
fi

# Patch feature toggles (user-editable): {"<feature>": false}, absent = on.
# Written only when missing — the user's choices survive updates/uninstalls.
if [ ! -f "$CLAWGOD_DIR/patches.json" ]; then
  printf '{}\n' > "$CLAWGOD_DIR/patches.json"
  info "Default patches.json created (all features on)"
fi

# ─── Lean mode: optimize ~/.claude/settings.json ─────
# Three levels: off / on (default) / max
# State persisted via .lean-disabled and .lean-max flag files.
# Installer respects existing state on updates — never overwrites user choice.

LEAN_OFF_FLAG="$CLAWGOD_DIR/.lean-disabled"
LEAN_MAX_FLAG="$CLAWGOD_DIR/.lean-max"

# Handle explicit toggle from CLI (--lean-off / --lean-on / --lean-max)
if [ "$LEAN_OFF" = "1" ]; then
  touch "$LEAN_OFF_FLAG"; rm -f "$LEAN_MAX_FLAG"
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$CLAUDE_SETTINGS" ]; then
    node -e '
const fs=require("fs"),p=process.argv[1];
const allDeny=new Set(["DesignSync","NotebookEdit","PushNotification","RemoteTrigger","CronCreate","CronDelete","CronList","EnterPlanMode","ExitPlanMode","SendMessage","ScheduleWakeup","AskUserQuestion","ReportFindings"]);
const allFlags=["disableWorkflows","disableRemoteControl","disableClaudeAiConnectors","disableArtifact","disableBundledSkills"];
let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{process.exit(0)}
for(const k of allFlags)delete s[k];
if(Array.isArray(s.permissions?.deny))s.permissions.deny=s.permissions.deny.filter(t=>!allDeny.has(t));
fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");
' "$CLAUDE_SETTINGS" 2>/dev/null
  fi
  info "Lean mode disabled (all tools restored)"
elif [ "$LEAN_ON" = "1" ]; then
  rm -f "$LEAN_OFF_FLAG" "$LEAN_MAX_FLAG"
elif [ "$LEAN_MAX" = "1" ]; then
  rm -f "$LEAN_OFF_FLAG"; touch "$LEAN_MAX_FLAG"
fi

if [ ! -f "$LEAN_OFF_FLAG" ]; then
  CLAUDE_SETTINGS_DIR="$HOME/.claude"
  CLAUDE_SETTINGS="$CLAUDE_SETTINGS_DIR/settings.json"
  mkdir -p "$CLAUDE_SETTINGS_DIR"
  LEAN_IS_MAX="false"
  [ -f "$LEAN_MAX_FLAG" ] && LEAN_IS_MAX="true"

  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
const isMax = process.argv[2] === "true";
const baseDeny = ["DesignSync","NotebookEdit","PushNotification","RemoteTrigger","CronCreate","CronDelete","CronList"];
const maxDeny = ["EnterPlanMode","ExitPlanMode","SendMessage","ScheduleWakeup","AskUserQuestion","ReportFindings"];
const baseFlags = ["disableWorkflows","disableRemoteControl","disableClaudeAiConnectors","disableArtifact"];
const maxFlags = ["disableBundledSkills"];
const deny = isMax ? [...baseDeny, ...maxDeny] : baseDeny;
const flags = isMax ? [...baseFlags, ...maxFlags] : baseFlags;
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
let changed = false;
for (const k of flags) { if (!(k in s)) { s[k] = true; changed = true; } }
if (!s.permissions) s.permissions = {};
if (!Array.isArray(s.permissions.deny)) s.permissions.deny = [];
const ex = new Set(s.permissions.deny);
for (const t of deny) { if (!ex.has(t)) { s.permissions.deny.push(t); changed = true; } }
if (changed) fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
' "$CLAUDE_SETTINGS" "$LEAN_IS_MAX" 2>/dev/null

  if [ -f "$LEAN_MAX_FLAG" ]; then
    info "Lean settings applied: max (~/.claude/settings.json)"
  else
    info "Lean settings applied: on (~/.claude/settings.json)"
  fi
else
  dim "Lean mode disabled (claude --lean-on to re-enable)"
fi

# ─── Sanity check: ensure user's Bun can actually load cli.original.cjs ──
# Anthropic builds the native binary with a bleeding-edge Bun build (e.g.
# 1.3.14 while stable still ships 1.3.13). Older Bun crashes loading the
# extracted cli.original.cjs with "Expected CommonJS module to have a
# function wrapper". Detect this BEFORE we install the launcher — better
# to fail loudly than to leave the user with a launcher that panics on
# first invocation.

dim "Verifying Bun can load patched cli.original.cjs ..."
sanity_out=$("$BUN_BIN" "$CLAWGOD_DIR/cli.cjs" --version 2>&1 || true)
if echo "$sanity_out" | grep -q "Expected CommonJS module to have a function wrapper"; then
  echo ""
  warn "Bun $($BUN_BIN --version) cannot load Anthropic's cli.original.cjs."
  warn ""
  warn "  Anthropic builds with Bun's canary channel (currently ~1.3.14), while"
  warn "  bun.sh's main download is on stable (currently 1.3.13). The canary build"
  warn "  is NOT visible on bun.sh's download page — it lives on GitHub Releases"
  warn "  and is reachable only via 'bun upgrade --canary'."
  warn ""
  warn "  If your bun is from bun.sh:"
  warn "    bun upgrade --canary"
  warn ""
  warn "  If your bun is from a package manager (brew/apt/scoop) where the binary"
  warn "  is behind a shim and refuses to self-replace ('bun upgrade' silently"
  warn "  hangs or no-ops):"
  warn "    <pkg-manager> uninstall bun"
  warn "    curl -fsSL https://bun.sh/install | bash"
  warn "    bun upgrade --canary"
  warn ""
  warn "  Then re-run install.sh — this sanity check will pass."
  exit 1
fi
info "Bun loads cli.original.cjs"

# ─── Replace claude command ───────────────────────────

# Detect where claude is actually installed (supports native, npm, pnpm, yarn).
# `command -v` is a POSIX builtin (works even on minimal images that no
# longer ship `which`); `|| true` keeps a clean miss from tripping
# `set -e` via the assignment's exit status under bash 5+.
CLAUDE_BIN=$(command -v claude 2>/dev/null || true)
if [ -z "$CLAUDE_BIN" ]; then
  # No claude in PATH — use default location
  CLAUDE_BIN="$BIN_DIR/claude"
  dim "No existing claude found, installing to $BIN_DIR"
fi
CLAUDE_DIR=$(dirname "$CLAUDE_BIN")

# ─── Download clawgod-import binary ─────────────────────
IMPORT_BIN="$CLAWGOD_DIR/clawgod-import"
if [ ! -x "$IMPORT_BIN" ]; then
  IMPORT_ARCH="$(uname -m)"
  IMPORT_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$IMPORT_ARCH" in
    x86_64|amd64) IMPORT_ARCH="x64" ;;
    aarch64|arm64) IMPORT_ARCH="arm64" ;;
  esac
  case "$IMPORT_OS" in
    darwin) IMPORT_SUFFIX="darwin-$IMPORT_ARCH" ;;
    linux)  IMPORT_SUFFIX="linux-$IMPORT_ARCH" ;;
    *)      IMPORT_SUFFIX="" ;;
  esac
  if [ -n "$IMPORT_SUFFIX" ]; then
    IMPORT_URL="https://github.com/0Chencc/clawgod/releases/latest/download/clawgod-import-$IMPORT_SUFFIX"
    if curl -fsSL -o "$IMPORT_BIN" "$IMPORT_URL" 2>/dev/null; then
      chmod +x "$IMPORT_BIN"
      info "Provider import tool installed (clawgod-import)"
    else
      dim "Provider import tool not yet available (build pending)"
    fi
  fi
fi

LAUNCHER_CONTENT="#!/bin/bash
# clawgod launcher
CLAWGOD_CLI=\"$CLAWGOD_DIR/cli.cjs\"
CLAWGOD_IMPORT=\"$CLAWGOD_DIR/clawgod-import\"
BUN_BIN=\"$BUN_BIN\"
# Route 'import' subcommand to clawgod-import binary
if [ \"\$1\" = \"import\" ]; then
  shift
  if [ -x \"\$CLAWGOD_IMPORT\" ]; then
    exec \"\$CLAWGOD_IMPORT\" \"\$@\"
  else
    echo \"clawgod: import tool not installed. Reinstall clawgod to get it.\" >&2
    exit 127
  fi
fi
if [ ! -f \"\$CLAWGOD_CLI\" ]; then
  echo \"clawgod: installation at $CLAWGOD_DIR is missing (cli.cjs not found)\" >&2
  echo \"clawgod: reinstall via  curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash\" >&2
  echo \"clawgod: or remove this launcher:  rm \\\"\$0\\\"\" >&2
  exit 127
fi
if [ ! -x \"\$BUN_BIN\" ]; then
  if command -v bun >/dev/null 2>&1; then BUN_BIN=\"\$(command -v bun)\"; fi
fi
if [ ! -x \"\$BUN_BIN\" ]; then
  echo \"clawgod: bun runtime not found at \$BUN_BIN\" >&2
  echo \"clawgod: install bun  curl -fsSL https://bun.sh/install | bash\" >&2
  exit 127
fi
export CLAUDE_CODE_EXECPATH=\"$CLAUDE_BIN.orig\"
export HERDR_AGENT=\"\${HERDR_AGENT:-claude}\"
exec \"\$BUN_BIN\" \"\$CLAWGOD_CLI\" \"\$@\""


# Back up original claude (only once)
if [ ! -e "$CLAUDE_BIN.orig" ]; then
  if [ -L "$CLAUDE_BIN" ]; then
    # Symlink (native install) — preserve target
    NATIVE_BIN="$(readlink "$CLAUDE_BIN")"
    ln -sf "$NATIVE_BIN" "$CLAUDE_BIN.orig"
    info "Original claude backed up → claude.orig (→ $NATIVE_BIN)"
  elif [ -f "$CLAUDE_BIN" ] && file "$CLAUDE_BIN" 2>/dev/null | grep -q "Mach-O\|ELF\|script"; then
    # Binary or script (pnpm/npm global install)
    cp "$CLAUDE_BIN" "$CLAUDE_BIN.orig"
    info "Original claude backed up → claude.orig"
  else
    # Try versions dir as fallback
    VERSIONS_DIR="$HOME/.local/share/claude/versions"
    if [ -d "$VERSIONS_DIR" ]; then
      NATIVE_BIN="$(ls -t "$VERSIONS_DIR"/* 2>/dev/null | while read f; do
        file "$f" 2>/dev/null | grep -q "Mach-O\|ELF" && echo "$f" && break
      done)" || true
      if [ -n "$NATIVE_BIN" ]; then
        ln -sf "$NATIVE_BIN" "$CLAUDE_BIN.orig"
        info "Original claude backed up → claude.orig (→ $NATIVE_BIN)"
      fi
    fi
  fi
fi

# Write launcher to the SAME directory where claude was found.
# CRITICAL: `echo > $f` follows symlinks — if $CLAUDE_BIN is a symlink
# (e.g. official ~/.local/bin/claude → ~/.local/share/claude/versions/X)
# we'd write our launcher into the real binary and destroy it. Always
# remove the existing entry first so we write a fresh regular file.
write_launcher() {
  local target="$1"
  local dir
  dir=$(dirname "$target")
  mkdir -p "$dir"
  rm -f "$target"
  printf '%s\n' "$LAUNCHER_CONTENT" > "$target"
  chmod +x "$target"
}

write_launcher "$CLAUDE_BIN"
info "Command 'claude' → patched ($CLAUDE_BIN)"

# Also install to ~/.local/bin if claude was elsewhere (ensures PATH consistency)
if [ "$CLAUDE_DIR" != "$BIN_DIR" ]; then
  write_launcher "$BIN_DIR/claude"
  dim "Also installed to $BIN_DIR/claude"
fi

# Always expose an unambiguous `clawgod` alias alongside the `claude` override.
# Useful when:
#  - Windows .exe overshadows our .cmd (clawgod has no .exe competitor)
#  - User wants explicit "patched" intent
#  - User restored claude.orig via uninstall but still wants the patched one
write_launcher "$BIN_DIR/clawgod"
info "Command 'clawgod' → patched ($BIN_DIR/clawgod)"

# ─── Check PATH ───────────────────────────────────────

if ! echo "$PATH" | grep -q "$CLAUDE_DIR" && ! echo "$PATH" | grep -q "$BIN_DIR"; then
  # Detect shell config file
  case "$(basename "$SHELL")" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="$HOME/.bashrc" ;;
    fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
    *)    SHELL_RC="$HOME/.profile" ;;
  esac
  echo ""
  warn "$BIN_DIR is not in PATH. Run:"
  dim "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_RC && source $SHELL_RC"
fi

# ─── Flush shell cache ────────────────────────────────

hash -r 2>/dev/null

# ─── Done ─────────────────────────────────────────────

echo ""
echo -e "  ${BOLD}${GREEN}ClawGod installed!${NC}"
echo ""
dim "  claude            — Start patched Claude Code (green logo)"
dim "  claude.orig       — Run original unpatched Claude Code"
echo ""
dim "  Updates: 'claude update' is patched to route through this installer."
dim "  Just run it as usual — pulls latest Anthropic release + re-patches"
dim "  in one step. Extra options:"
dim "    claude update --version 2.1.180   (install a specific version)"
dim "    claude update --no-upgrade        (re-patch without downloading)"
dim "  To leave clawgod and use vanilla update:"
dim "    bash ~/.clawgod/install.sh --uninstall"
echo ""
warn "  If 'claude' still runs the old version, restart your terminal or run: hash -r"
echo ""
dim "  Config: ~/.clawgod/provider.json"
dim "  Flags:  ~/.clawgod/features.json"
echo ""
dim "  If 'claude' panics with 'Expected CommonJS module to have a function wrapper',"
dim "  your Bun lags Anthropic's embedded Bun. Upgrade with one of:"
dim "    bun upgrade --canary           (if installed via curl/install.sh)"
dim "    scoop update bun               (scoop — may lag stable)"
dim "    brew upgrade bun               (homebrew)"
echo ""
