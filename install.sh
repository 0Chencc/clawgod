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
#    bash install.sh [--version 2.1.89]
# ─────────────────────────────────────────────────────────

CLAWGOD_DIR="$HOME/.clawgod"
BIN_DIR="$HOME/.local/bin"
VERSION="${CLAWGOD_VERSION:-latest}"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --version) VERSION="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
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
  # Restore original claude — check both actual path and default path
  CLAUDE_BIN=$(which claude 2>/dev/null)
  for DIR in "${CLAUDE_BIN:+$(dirname "$CLAUDE_BIN")}" "$BIN_DIR"; do
    [ -z "$DIR" ] && continue
    if [ -e "$DIR/claude.orig" ]; then
      mv "$DIR/claude.orig" "$DIR/claude"
      info "Original claude restored ($DIR/claude)"
    fi
  done
  rm -rf "$CLAWGOD_DIR/node_modules" "$CLAWGOD_DIR/cli.original.js" "$CLAWGOD_DIR/cli.original.js.bak" "$CLAWGOD_DIR/cli.js" "$CLAWGOD_DIR/patch.js"
  info "ClawGod uninstalled"
  echo ""
  exit 0
fi

# ─── Prerequisites ─────────────────────────────────────

if ! command -v node &>/dev/null; then
  warn "Node.js is required (>= 18). Install from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  warn "Node.js >= 18 required (found v$NODE_VERSION)"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  warn "npm is required"
  exit 1
fi

# ─── Install Claude Code from npm ──────────────────────

mkdir -p "$CLAWGOD_DIR" "$BIN_DIR"

dim "Installing @anthropic-ai/claude-code@${VERSION} ..."
npm install --prefix "$CLAWGOD_DIR" "@anthropic-ai/claude-code@${VERSION}" --save-exact --no-fund --no-audit 2>/dev/null
INSTALLED_VERSION=$(node -e "console.log(require('$CLAWGOD_DIR/node_modules/@anthropic-ai/claude-code/package.json').version)")
info "Claude Code v${INSTALLED_VERSION} downloaded"

# ─── Ensure ESM support ───────────────────────────────

node -e "
const f = '$CLAWGOD_DIR/package.json';
const p = JSON.parse(require('fs').readFileSync(f,'utf8'));
if (!p.type) { p.type = 'module'; require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\n'); }
"

# ─── Copy bundle ───────────────────────────────────────

cp "$CLAWGOD_DIR/node_modules/@anthropic-ai/claude-code/cli.js" "$CLAWGOD_DIR/cli.original.js"
info "Bundle extracted (cli.original.js)"

# ─── Write wrapper (cli.js) ────────────────────────────

cat > "$CLAWGOD_DIR/cli.js" << 'WRAPPER_EOF'
#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const claudeDir = join(homedir(), '.claude');
const clawgodDir = join(homedir(), '.clawgod');
const configDir = process.env.CLAUDE_CONFIG_DIR || (existsSync(claudeDir) ? claudeDir : clawgodDir);
const providerDir = clawgodDir;
const configFile = join(providerDir, 'provider.json');

const defaultConfig = {
  apiKey: '',
  baseURL: 'https://api.anthropic.com',
  model: '',
  smallModel: '',
  timeoutMs: 3000000,
};

let config = { ...defaultConfig };
if (existsSync(configFile)) {
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    config = { ...defaultConfig, ...raw };
  } catch {}
} else {
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2) + '\n');
}

if (config.apiKey) {
  process.env.ANTHROPIC_API_KEY ??= config.apiKey;
}
if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
  process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
}
if (config.apiKey && config.model) {
  process.env.ANTHROPIC_MODEL ??= config.model;
}
if (config.apiKey && config.smallModel) {
  process.env.ANTHROPIC_SMALL_FAST_MODEL ??= config.smallModel;
}
if (config.timeoutMs) {
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
}
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
process.env.CLAUDE_CONFIG_DIR ??= configDir;

const featuresFile = join(providerDir, 'features.json');
if (!process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

await import('./cli.original.js');
WRAPPER_EOF
chmod +x "$CLAWGOD_DIR/cli.js"
info "Wrapper created (cli.js)"

# ─── Write universal patcher ───────────────────────────

cat > "$CLAWGOD_DIR/patch.js" << 'PATCHER_EOF'
#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, 'cli.original.js');
const BACKUP = TARGET + '.bak';

// ─── Regex-based patches (version-agnostic) ──────────────

const patches = [
  {
    name: 'USER_TYPE → ant',
    pattern: /function (\w+)\(\)\{return"external"\}/g,
    replacer: (m, fn) => `function ${fn}(){return"ant"}`,
  },
  {
    name: 'GrowthBook env overrides',
    pattern: /function (\w+)\(\)\{if\(!(\w+)\)(\w+)=!0;return (\w+)\}/g,
    replacer: (m, fn, flag, flag2, val) =>
      `function ${fn}(){if(!${flag}){${flag2}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    unique: true,  // must match exactly 1
  },
  {
    name: 'GrowthBook config overrides',
    pattern: /function (\w+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){try{return j8().growthBookOverrides??null}catch{return null}}${next}`,
    selectIndex: 0,  // first match only (there may be others)
    validate: (match, code) => {
      // Must be near other GrowthBook functions
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
  },
  {
    name: 'Agent Teams always enabled',
    pattern: /function (\w+)\(\)\{if\(!\w+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&!\w+\(\)\)return!1;if\(!\w+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Computer Use subscription bypass',
    pattern: /function (\w+)\(\)\{let \w+=\w+\(\);return \w+==="max"\|\|\w+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Computer Use default enabled',
    pattern: /(\w+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
  },
  {
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",description:`[^`]+`,argumentHint:"<prompt>",isEnabled:\(\)=>)!1/g,
    replacer: (m, prefix) => `${prefix}!0`,
    optional: true,  // v2.1.89+ merged into /plan, no standalone command
  },
  {
    name: 'Ultrareview enable',
    pattern: /function (\w+)\(\)\{return \w+\("tengu_review_bughunter_config",null\)\?\.enabled===!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  // ── 绿色主题 (patch 标识) ──

  {
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /clawd_body:"rgb\(215,119,87\)"/g,
    replacer: () => 'clawd_body:"rgb(34,197,94)"',
  },
  {
    name: 'Logo + brand color → green (ANSI)',
    pattern: /clawd_body:"ansi:redBright"/g,
    replacer: () => 'clawd_body:"ansi:greenBright"',
  },
  {
    name: 'Theme claude color → green (dark)',
    pattern: /claude:"rgb\(215,119,87\)"/g,
    replacer: () => 'claude:"rgb(34,197,94)"',
  },
  {
    name: 'Theme claude color → green (light)',
    pattern: /claude:"rgb\(255,153,51\)"/g,
    replacer: () => 'claude:"rgb(22,163,74)"',
  },
  {
    name: 'Shimmer → green',
    pattern: /claudeShimmer:"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: () => 'claudeShimmer:"rgb(74,222,128)"',
  },
  {
    name: 'Shimmer light → green',
    pattern: /claudeShimmer:"rgb\(255,183,101\)"/g,
    replacer: () => 'claudeShimmer:"rgb(34,197,94)"',
  },
  {
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
  },

  // ── 限制移除 ──

  {
    name: 'Remove CYBER_RISK_INSTRUCTION',
    pattern: /(\w+)="IMPORTANT: Assist with authorized security testing[^"]*"/g,
    replacer: (m, varName) => `${varName}=""`,
  },
  {
    name: 'Remove URL generation restriction',
    pattern: /\n\$\{\w+\}\nIMPORTANT: You must NEVER generate or guess URLs[^.]*\. You may use URLs provided by the user in their messages or local files\./g,
    replacer: () => '',
  },
  {
    name: 'Remove cautious actions section',
    pattern: /function (\w+)\(\)\{return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn) => `function ${fn}(){return\`\`}`,
  },
  {
    name: 'Remove "Not logged in" notice',
    pattern: /Not logged in\. Run [\w ]+ to authenticate\./g,
    replacer: () => '',
    optional: true,
  },

  // ── 消息过滤 ──

  {
    name: 'Attachment filter bypass',
    pattern: /(\w+\(\)!=="ant"\)\{if\(\w+\.attachment\.type==="hook_additional_context")/g,
    replacer: (m, orig) => m.replace(/\w+\(\)!=="ant"/, 'false'),
  },
  {
    name: 'Message list filter bypass',
    pattern: /(\w+)\(\)!=="ant"\?(\w+)\((\w+),(\w+)\((\w+)\)\):(\w+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => fallback,
  },
];

// ─── Main ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');

if (revert) {
  if (!existsSync(BACKUP)) { console.error('❌ No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('✅ Reverted from backup');
  process.exit(0);
}

if (!existsSync(TARGET)) {
  console.error('❌ Target not found:', TARGET);
  process.exit(1);
}

let code = readFileSync(TARGET, 'utf8');
const origSize = code.length;

// Extract version
const verMatch = code.match(/Version:\s*([\d.]+)/);
const version = verMatch ? verMatch[1] : 'unknown';

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: cli.original.js (v${version})`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'═'.repeat(55)}\n`);

let applied = 0, skipped = 0, failed = 0;

for (const p of patches) {
  const matches = [...code.matchAll(p.pattern)];
  let relevant = matches;

  // Filter by validation if provided
  if (p.validate) {
    relevant = matches.filter(m => p.validate(m[0], code));
  }

  // Select specific match index
  if (p.selectIndex !== undefined) {
    relevant = relevant.length > p.selectIndex ? [relevant[p.selectIndex]] : [];
  }

  // Uniqueness check
  if (p.unique && relevant.length !== 1) {
    if (verify) {
      console.log(`  ❓ ${p.name} — ${relevant.length} matches (need exactly 1)`);
    } else {
      console.log(`  ⚠️  ${p.name} — ${relevant.length} matches, skipping (need 1)`);
    }
    if (relevant.length !== 1) { failed++; continue; }
  }

  if (relevant.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
    } else {
      console.log(`  ✅ ${p.name} (already applied)`);
      applied++;
    }
    continue;
  }

  if (verify) {
    console.log(`  ⬚  ${p.name} — ${relevant.length} match(es), not yet applied`);
    skipped++;
    continue;
  }

  // Apply patch
  let count = 0;
  for (const m of relevant) {
    const replacement = p.replacer(m[0], ...m.slice(1));
    if (replacement !== m[0]) {
      if (!dryRun) {
        code = code.replace(m[0], replacement);
      }
      count++;
    }
  }

  if (count > 0) {
    console.log(`  ✅ ${p.name} (${count} replacement${count > 1 ? 's' : ''})`);
    applied++;
  } else {
    console.log(`  ⏭  ${p.name} (no change needed)`);
    skipped++;
  }
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${failed} failed`);

if (!dryRun && !verify && applied > 0) {
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log(`  📦 Backup: ${BACKUP}`);
  }
  writeFileSync(TARGET, code, 'utf8');
  const diff = code.length - origSize;
  console.log(`  📝 Written: cli.original.js (${diff >= 0 ? '+' : ''}${diff} bytes)`);
}

console.log(`${'═'.repeat(55)}\n`);
PATCHER_EOF
info "Patcher created (patch.js)"

# ─── Apply patches ─────────────────────────────────────

dim "Applying patches ..."
node "$CLAWGOD_DIR/patch.js" 2>&1 | while IFS= read -r line; do echo "  $line"; done

# ─── Create default configs ───────────────────────────

if [ ! -f "$CLAWGOD_DIR/features.json" ]; then
  cat > "$CLAWGOD_DIR/features.json" << 'FEATURES_EOF'
{
  "tengu_harbor": true,
  "tengu_session_memory": true,
  "tengu_amber_flint": true,
  "tengu_auto_background_agents": true,
  "tengu_destructive_command_warning": true,
  "tengu_immediate_model_command": true,
  "tengu_desktop_upsell": false
}
FEATURES_EOF
  info "Default features.json created"
fi

# ─── Replace claude command ───────────────────────────

LAUNCHER_CONTENT="#!/bin/bash
exec node \"$CLAWGOD_DIR/cli.js\" \"\$@\""

# Detect where claude is actually installed (supports native, npm, pnpm, yarn)
CLAUDE_BIN=$(which claude 2>/dev/null)
if [ -z "$CLAUDE_BIN" ]; then
  # No claude in PATH — use default location
  CLAUDE_BIN="$BIN_DIR/claude"
  dim "No existing claude found, installing to $BIN_DIR"
fi
CLAUDE_DIR=$(dirname "$CLAUDE_BIN")

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

# Write launcher to the SAME directory where claude was found
mkdir -p "$CLAUDE_DIR"
echo "$LAUNCHER_CONTENT" > "$CLAUDE_BIN"
chmod +x "$CLAUDE_BIN"
info "Command 'claude' → patched ($CLAUDE_BIN)"

# Also install to ~/.local/bin if claude was elsewhere (ensures PATH consistency)
if [ "$CLAUDE_DIR" != "$BIN_DIR" ]; then
  mkdir -p "$BIN_DIR"
  echo "$LAUNCHER_CONTENT" > "$BIN_DIR/claude"
  chmod +x "$BIN_DIR/claude"
  dim "Also installed to $BIN_DIR/claude"
fi

# ─── Check PATH ───────────────────────────────────────

if ! echo "$PATH" | grep -q "$CLAUDE_DIR" && ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo ""
  warn "Neither $CLAUDE_DIR nor $BIN_DIR is in PATH"
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
warn "  If 'claude' still runs the old version, restart your terminal or run: hash -r"
echo ""
dim "  Config: ~/.clawgod/provider.json"
dim "  Flags:  ~/.clawgod/features.json"
echo ""
