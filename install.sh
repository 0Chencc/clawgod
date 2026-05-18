#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────
#  ClawGod Installer
#
#  Downloads Claude Code from npm, applies patches, replaces claude command
#
#  用法:
#    curl -fsSL https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.sh | bash
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
  rm -rf "$CLAWGOD_DIR/node_modules" "$CLAWGOD_DIR/vendor" "$CLAWGOD_DIR/bun-runtime" "$CLAWGOD_DIR/cli.original.js" "$CLAWGOD_DIR/cli.original.js.bak" "$CLAWGOD_DIR/cli.original.cjs" "$CLAWGOD_DIR/cli.original.cjs.bak" "$CLAWGOD_DIR/cli.js" "$CLAWGOD_DIR/cli.cjs" "$CLAWGOD_DIR/patch.mjs" "$CLAWGOD_DIR/patch.js" "$CLAWGOD_DIR/extract-natives.mjs" "$CLAWGOD_DIR/post-process.mjs" "$CLAWGOD_DIR/repatch.mjs" "$CLAWGOD_DIR/.source-version"
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
  dim "Fetching $NPM_PKG@latest from npm registry ..."
  NATIVE_BIN_TMPDIR=$(mktemp -d)
  if ( cd "$NATIVE_BIN_TMPDIR" && npm pack "$NPM_PKG@latest" --silent >/dev/null 2>&1 ); then
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
  warn "Native Claude Code binary not found in $VERSIONS_DIR"
  warn "Install the official binary first:"
  warn "  curl -fsSL https://claude.ai/install.sh | bash"
  warn "Then re-run this script."
  exit 1
fi

# Write extractor to a temp file (used both for cli.js and .node modules)
cat > "$CLAWGOD_DIR/extract-natives.mjs" << 'EXTRACTOR_EOF'
#!/usr/bin/env node
/**
 * ClawGod native module extractor
 *
 * Extracts embedded .node NAPI modules from a Bun single-file executable
 * (the official Claude Code native binary).
 *
 * Supports:
 *   - Mach-O (macOS) — arm64 + x86_64 thin binaries
 *   - ELF (Linux)    — arm64 + x86_64
 *   - PE (Windows)   — x86_64 + arm64
 *
 * Usage:
 *   node extract-natives.mjs <binary-path> <output-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';

// ─── Mach-O constants ────────────────────────────────────────────────

const MH_MAGIC_64 = 0xfeedfacf;           // little-endian 64-bit
const LC_SEGMENT_64 = 0x19;
const LC_ID_DYLIB = 0x0d;
const MH_DYLIB = 6;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

// ─── ELF constants ───────────────────────────────────────────────────

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // 7f 'E' 'L' 'F'
const ET_DYN = 3;                          // shared object
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// ─── PE constants ────────────────────────────────────────────────────

const MZ_MAGIC = Buffer.from([0x4d, 0x5a]);   // "MZ"
const PE_MAGIC = Buffer.from([0x50, 0x45, 0, 0]); // "PE\0\0"
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_DLL = 0x2000;

// ─── Helpers ─────────────────────────────────────────────────────────

function archName(format, cputype) {
  if (format === 'macho') {
    if (cputype === CPU_TYPE_ARM64) return 'arm64';
    if (cputype === CPU_TYPE_X86_64) return 'x64';
  }
  if (format === 'elf') {
    if (cputype === EM_AARCH64) return 'arm64';
    if (cputype === EM_X86_64) return 'x64';
  }
  if (format === 'pe') {
    if (cputype === IMAGE_FILE_MACHINE_ARM64) return 'arm64';
    if (cputype === IMAGE_FILE_MACHINE_AMD64) return 'x64';
  }
  return null;
}

function platformSuffix(format, arch) {
  const os = format === 'macho' ? 'darwin' : format === 'elf' ? 'linux' : 'win32';
  return `${arch}-${os}`;
}

// ─── Mach-O parser ───────────────────────────────────────────────────

function parseMachODylib(buf, off) {
  const magic = buf.readUInt32LE(off);
  if (magic !== MH_MAGIC_64) return null;

  const cputype = buf.readUInt32LE(off + 4);
  if (cputype !== CPU_TYPE_ARM64 && cputype !== CPU_TYPE_X86_64) return null;

  const filetype = buf.readUInt32LE(off + 12);
  if (filetype !== MH_DYLIB) return null;

  const ncmds = buf.readUInt32LE(off + 16);
  if (ncmds === 0 || ncmds > 500) return null;

  let totalFileEnd = 0;
  let installName = null;
  let cmdOff = off + 32;

  for (let i = 0; i < ncmds; i++) {
    if (cmdOff + 8 > buf.length) return null;

    const cmd = buf.readUInt32LE(cmdOff);
    const cmdsize = buf.readUInt32LE(cmdOff + 4);
    if (cmdsize === 0 || cmdsize > 65536) return null;

    if (cmd === LC_SEGMENT_64) {
      const fileoff = Number(buf.readBigUInt64LE(cmdOff + 40));
      const filesize = Number(buf.readBigUInt64LE(cmdOff + 48));
      const end = fileoff + filesize;
      if (end > totalFileEnd) totalFileEnd = end;
    } else if (cmd === LC_ID_DYLIB) {
      // dylib_command: uint32 cmd, cmdsize, str_offset, timestamp, version...
      // then name string at cmdOff + str_offset
      const strOff = buf.readUInt32LE(cmdOff + 8);
      const nameStart = cmdOff + strOff;
      const nameEnd = buf.indexOf(0, nameStart);
      if (nameEnd !== -1 && nameEnd - nameStart < 1024) {
        installName = buf.slice(nameStart, nameEnd).toString('utf8');
      }
    }

    cmdOff += cmdsize;
  }

  if (totalFileEnd === 0) return null;

  return {
    offset: off,
    size: totalFileEnd,
    arch: archName('macho', cputype),
    installName,
  };
}

function extractMachODylibs(buf) {
  const dylibs = [];
  // Magic bytes for fast indexOf scan: cf fa ed fe (MH_MAGIC_64 LE)
  const magicBytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

  let off = 1;  // skip the main binary at offset 0
  while ((off = buf.indexOf(magicBytes, off)) !== -1) {
    const info = parseMachODylib(buf, off);
    if (info && off + info.size <= buf.length) {
      dylibs.push(info);
      off += info.size;  // skip past this dylib
    } else {
      off += 4;
    }
  }

  return dylibs;
}

// ─── ELF parser ──────────────────────────────────────────────────────

function parseELFSharedObject(buf, off) {
  if (buf.length - off < 64) return null;
  if (!buf.slice(off, off + 4).equals(ELF_MAGIC)) return null;

  const eiClass = buf.readUInt8(off + 4);        // 1=32-bit, 2=64-bit
  if (eiClass !== 2) return null;

  const eiData = buf.readUInt8(off + 5);         // 1=LE, 2=BE
  if (eiData !== 1) return null;                 // only LE supported

  const eType = buf.readUInt16LE(off + 16);
  if (eType !== ET_DYN) return null;

  const eMachine = buf.readUInt16LE(off + 18);
  if (eMachine !== EM_X86_64 && eMachine !== EM_AARCH64) return null;

  // ELF64 header layout:
  //   e_shoff (section header offset): off + 40 (u64)
  //   e_shentsize: off + 58 (u16)
  //   e_shnum:     off + 60 (u16)
  const shoff = Number(buf.readBigUInt64LE(off + 40));
  const shentsize = buf.readUInt16LE(off + 58);
  const shnum = buf.readUInt16LE(off + 60);

  if (shentsize !== 64 || shnum === 0 || shnum > 1000) return null;

  // Total size = shoff + shnum * shentsize (the section header table is at the end)
  const totalSize = shoff + shnum * shentsize;
  if (totalSize > buf.length - off) return null;

  return {
    offset: off,
    size: totalSize,
    arch: archName('elf', eMachine),
    installName: null,  // ELF soname requires dynamic section walk; we'll rely on adjacent strings
  };
}

function extractELFSharedObjects(buf) {
  const sos = [];

  // Scan for ELF magic; ELF headers are rare in data so 4-byte alignment is fine
  for (let off = 4; off < buf.length - 64; off += 4) {
    if (buf.readUInt8(off) !== 0x7f) continue;
    const info = parseELFSharedObject(buf, off);
    if (!info) continue;
    if (off + info.size > buf.length) continue;
    sos.push(info);
  }

  return sos;
}

// ─── PE parser ───────────────────────────────────────────────────────

function parsePEDll(buf, off) {
  if (buf.length - off < 1024) return null;
  if (!buf.slice(off, off + 2).equals(MZ_MAGIC)) return null;

  // PE header offset at MZ + 0x3c (e_lfanew)
  const peOff = buf.readUInt32LE(off + 0x3c);
  if (peOff > 4096) return null;                 // sanity

  if (off + peOff + 24 > buf.length) return null;
  if (!buf.slice(off + peOff, off + peOff + 4).equals(PE_MAGIC)) return null;

  const machine = buf.readUInt16LE(off + peOff + 4);
  if (machine !== IMAGE_FILE_MACHINE_AMD64 && machine !== IMAGE_FILE_MACHINE_ARM64) return null;

  const numberOfSections = buf.readUInt16LE(off + peOff + 6);
  const sizeOfOptionalHeader = buf.readUInt16LE(off + peOff + 20);
  const characteristics = buf.readUInt16LE(off + peOff + 22);
  if (!(characteristics & IMAGE_FILE_DLL)) return null;

  // Walk sections to find the max (PointerToRawData + SizeOfRawData)
  const sectionHeaderOff = off + peOff + 24 + sizeOfOptionalHeader;
  let totalSize = sectionHeaderOff - off;  // header area minimum

  for (let i = 0; i < numberOfSections; i++) {
    const secOff = sectionHeaderOff + i * 40;
    if (secOff + 40 > buf.length) return null;
    const sizeOfRawData = buf.readUInt32LE(secOff + 16);
    const pointerToRawData = buf.readUInt32LE(secOff + 20);
    const end = pointerToRawData + sizeOfRawData;
    if (end > totalSize) totalSize = end;
  }

  if (totalSize === 0 || totalSize > 50 * 1024 * 1024) return null;

  return {
    offset: off,
    size: totalSize,
    arch: archName('pe', machine),
    installName: null,
  };
}

function extractPEDlls(buf) {
  const dlls = [];

  for (let off = 0; off < buf.length - 1024; off++) {
    if (buf.readUInt8(off) !== 0x4d) continue;
    if (buf.readUInt8(off + 1) !== 0x5a) continue;
    const info = parsePEDll(buf, off);
    if (!info) continue;
    if (off + info.size > buf.length) continue;
    dlls.push(info);
  }

  return dlls;
}

// ─── Main dispatch ───────────────────────────────────────────────────

function detectFormat(buf) {
  if (buf.readUInt32LE(0) === MH_MAGIC_64) return 'macho';
  if (buf.slice(0, 4).equals(ELF_MAGIC)) return 'elf';
  if (buf.slice(0, 2).equals(MZ_MAGIC)) return 'pe';
  return null;
}

// Names to look for from install names / nearby strings
const KNOWN_MODULES = [
  'image-processor',
  'audio-capture',
  'computer-use-input',
  'computer-use-swift',
  'url-handler',
];

function identifyDylib(buf, dylib) {
  // 1. Try install name (most reliable)
  if (dylib.installName) {
    const base = basename(dylib.installName).replace(/\.(node|dylib|so|dll)$/, '');
    for (const m of KNOWN_MODULES) {
      if (base === m) return m;
      // Handle variants like "libcomputer_use_input.dylib"
      if (base === `lib${m.replace(/-/g, '_')}`) return m;
      if (base === `lib${m.replace(/-/g, '')}`) return m;
      if (base.toLowerCase().includes(m.replace(/-/g, ''))) return m;
    }
  }

  // 2. Scan the dylib body for known module name strings
  const body = buf.slice(dylib.offset, dylib.offset + dylib.size);
  for (const m of KNOWN_MODULES) {
    if (body.indexOf(Buffer.from(m)) !== -1) return m;
  }

  return null;
}

// ─── cli.js text extraction (Bun standalone) ─────────────────────────
//
// Two-stage anchor strategy:
//  1. Primary: Bun's bunfs path marker, observed in Mach-O / ELF builds.
//  2. Fallback: an application-level invariant ("cli_after_main_complete")
//     followed by a backwards scan to the IIFE start. Some Windows PE
//     builds don't appear to embed the bunfs path string we expect, so
//     this fallback recovers the same payload via app-level signals.

const CLI_PATH_MARKER = Buffer.from('file:///$bunfs/root/src/entrypoints/cli.js');
const CLI_FN_MARKER = Buffer.from('(function(exports, require, module');
const CLI_TAIL_MARKER = Buffer.from('cli_after_main_complete")}');
const CLI_END_MARKER = Buffer.from(');})');

function extractCliJs(buf) {
  // Primary anchor
  let fnStart = -1;
  const pathOff = buf.indexOf(CLI_PATH_MARKER);
  if (pathOff !== -1) {
    const candidate = buf.indexOf(CLI_FN_MARKER, pathOff);
    if (candidate !== -1 && candidate - pathOff <= 1024) fnStart = candidate;
  }

  // Fallback anchor: walk back from the source-level tail marker.
  if (fnStart === -1) {
    const tailMark = buf.indexOf(CLI_TAIL_MARKER);
    if (tailMark === -1) return null;
    const candidate = buf.lastIndexOf(CLI_FN_MARKER, tailMark);
    // The IIFE wraps the entire ~13 MB cli.js, so a valid candidate must
    // sit at least 1 MB before the tail marker. Smaller gaps mean we
    // matched a different (function(exports... wrapper for a sub-module.
    if (candidate === -1 || tailMark - candidate < 1024 * 1024) return null;
    fnStart = candidate;
  }

  // Resolve the IIFE close — search forward from fnStart so that we close
  // the wrapper we actually opened, regardless of which anchor located it.
  const tailFromFn = buf.indexOf(CLI_TAIL_MARKER, fnStart);
  if (tailFromFn === -1) return null;
  const ending = buf.indexOf(CLI_END_MARKER, tailFromFn);
  if (ending === -1 || ending - tailFromFn > 4096) return null;
  return buf.slice(fnStart, ending + CLI_END_MARKER.length).toString('utf8');
}

function main() {
  const [, , binaryPath, outputDir, ...rest] = process.argv;
  const wantCliJs = rest.includes('--cli-js');

  if (!binaryPath || !outputDir) {
    console.error('Usage: extract-natives.mjs <binary-path> <output-dir> [--cli-js]');
    process.exit(1);
  }

  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    process.exit(1);
  }

  const stat = statSync(binaryPath);
  if (stat.size < 10 * 1024 * 1024) {
    console.error(`Binary too small (${stat.size} bytes) — not a native Claude Code binary`);
    process.exit(1);
  }

  const buf = readFileSync(binaryPath);
  const format = detectFormat(buf);

  if (!format) {
    console.error('Unknown binary format (expected Mach-O / ELF / PE)');
    process.exit(1);
  }

  console.log(`Format:  ${format}`);
  console.log(`Size:    ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  if (wantCliJs) {
    const js = extractCliJs(buf);
    if (!js) {
      console.error('Could not locate cli.js payload in binary (markers missing).');
      process.exit(2);
    }
    mkdirSync(outputDir, { recursive: true });
    const out = join(outputDir, 'cli.original.js');
    writeFileSync(out, js);
    console.log(`  cli.js  ${(js.length / 1024 / 1024).toFixed(2)} MB → ${out}`);
    return;
  }

  let libs = [];
  if (format === 'macho') libs = extractMachODylibs(buf);
  else if (format === 'elf') libs = extractELFSharedObjects(buf);
  else if (format === 'pe') libs = extractPEDlls(buf);

  // Skip the first (main binary itself)
  libs = libs.filter(l => l.offset !== 0);

  console.log(`Found:   ${libs.length} embedded native libraries`);
  console.log();

  mkdirSync(outputDir, { recursive: true });

  const summary = { extracted: [], skipped: [] };

  for (const lib of libs) {
    const name = identifyDylib(buf, lib);
    if (!name) {
      summary.skipped.push({ ...lib, reason: 'unidentified' });
      continue;
    }

    const platform = platformSuffix(format, lib.arch);
    const targetDir = join(outputDir, name, platform);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, `${name}.node`);

    const data = buf.slice(lib.offset, lib.offset + lib.size);
    writeFileSync(targetFile, data);

    console.log(`  ✓ ${name.padEnd(20)} ${lib.arch.padEnd(6)} ${(lib.size / 1024).toFixed(0).padStart(5)} KB → ${targetFile}`);
    summary.extracted.push({ name, platform, size: lib.size });
  }

  console.log();
  console.log(`Extracted ${summary.extracted.length}, skipped ${summary.skipped.length}`);

  if (summary.skipped.length > 0) {
    console.log('\nSkipped (unidentified):');
    for (const s of summary.skipped) {
      console.log(`  offset=${s.offset} arch=${s.arch} size=${(s.size / 1024).toFixed(0)}KB`);
    }
  }
}

main();

EXTRACTOR_EOF

# ─── Extract cli.js + native modules from Bun binary ──────────
# Note: extract-natives.mjs and post-process.mjs are kept around (NOT deleted)
# so the wrapper's drift detector can re-run them when the user upgrades
# their native Claude binary.

VENDOR_DIR="$CLAWGOD_DIR/vendor"
rm -rf "$VENDOR_DIR" 2>/dev/null
mkdir -p "$VENDOR_DIR"

dim "Extracting cli.js from $(echo "$NATIVE_BIN_LABEL") ..."
if ! node "$CLAWGOD_DIR/extract-natives.mjs" "$NATIVE_BIN" "$CLAWGOD_DIR" --cli-js 2>&1 | while IFS= read -r line; do echo "  $line"; done; then
  err "Failed to extract cli.js from native binary"
  exit 1
fi
[ -f "$CLAWGOD_DIR/cli.original.js" ] || { err "cli.js missing after extraction"; exit 1; }

dim "Extracting native modules from $(echo "$NATIVE_BIN_LABEL") ..."
node "$CLAWGOD_DIR/extract-natives.mjs" "$NATIVE_BIN" "$VENDOR_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done || true

# ─── Post-process cli.js for Bun runtime ──────────────────────
# 1. Rewrite /$bunfs/root/X.node paths to point at extracted vendor modules
# 2. Rewrite build-time /home/runner/.../*.ts URLs (used by ripgrep,
#    sandbox, computer-use, etc. for asset resolution) to __filename so
#    relative resolutions land near our cli.original.cjs
# 3. Wrap the Bun-cjs IIFE with an actual invocation so `require()` runs it
# 4. Save as .cjs (Bun + CJS module wrapper)

dim "Rewriting bunfs paths and IIFE invocation ..."
cat > "$CLAWGOD_DIR/post-process.mjs" << 'POSTPROC_EOF'
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;

let code = readFileSync(src, 'utf8');

// (1) bunfs .node module paths → runtime vendor lookup
// WRAP IN TRY/CATCH: vendor/ may be empty (as of v2.1.142 no embedded .node
// modules are found), so require() throws MODULE_NOT_FOUND and crashes.
// The IIFE returns null on failure, preserving functionality for features
// whose native modules are missing while not crashing the whole process.
code = code.replace(
  /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
  (m, _full, name) => {
    const resolved = `require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')})`;
    return `((()=>{try{return require(${resolved})}catch(e){return null}})())`;
  },
);

// (2) build-time fileURLToPath() leaks → use cli.cjs's own __filename
code = code.replace(
  /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
  () => '__filename',
);

// (3) make the outer (function(...){...}) actually run
code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

writeFileSync(dst, code);
unlinkSync(src);
console.log(`cli.original.cjs: ${code.length} bytes`);

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

# ─── Write re-patch helper (used by wrapper on version drift) ─────────

cat > "$CLAWGOD_DIR/repatch.mjs" << 'REPATCH_EOF'
#!/usr/bin/env bun
// Re-extract + post-process + patch the user's currently-installed
// native Claude binary. Invoked by cli.cjs when it detects that
// .source-version no longer matches the latest binary in versions/.
import { spawnSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const nativeBin = process.argv[2];

if (!nativeBin || !existsSync(nativeBin)) {
  console.error('repatch: native binary path required and must exist');
  process.exit(1);
}

const vendor = join(here, 'vendor');
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

const runtime = process.execPath;

function run(label, args) {
  const r = spawnSync(runtime, args, { cwd: here, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`repatch: ${label} failed (exit ${r.status})`);
    process.exit(1);
  }
}

const extractor = join(here, 'extract-natives.mjs');
const postProc = join(here, 'post-process.mjs');
const patcher = join(here, 'patch.mjs');

run('extract cli.js', [extractor, nativeBin, here, '--cli-js']);
run('extract natives', [extractor, nativeBin, vendor]);
run('post-process', [postProc]);
run('patcher', [patcher]);

writeFileSync(join(here, '.source-version'), basename(nativeBin) + '\n');
console.log(`[clawgod] re-patched to ${basename(nativeBin)}`);

REPATCH_EOF
chmod +x "$CLAWGOD_DIR/repatch.mjs"
info "Re-patch helper installed (repatch.mjs)"

# ─── Write wrapper (cli.cjs, runs under Bun) ──────────────────

cat > "$CLAWGOD_DIR/cli.cjs" << 'WRAPPER_EOF'
#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } = require('fs');
const { join, basename } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const clawgodDir = join(homedir(), '.clawgod');

// Note: there used to be a "drift detection" block here that scanned
// ~/.local/share/claude/versions/ for a newer binary and silently re-patched.
// Removed because:
//   1. Windows users don't have a `versions/` directory at all (Anthropic's
//      Windows install doesn't follow that convention).
//   2. We patch out `claude update` (it would otherwise overwrite the bun
//      runtime under our launcher), so `versions/` no longer auto-grows
//      on a healthy clawgod install.
// In practice the block was reading a directory that never changes, but
// could *retract* a fresher version that install.sh just pulled from npm
// registry — putting users into a re-patch loop. Upgrades now go through
// the patched `claude update` → install.sh redirect, which always pulls
// the latest from npm.

// One-time migration: earlier wrapper versions set CLAUDE_CONFIG_DIR=~/.clawgod,
// which made Claude Code read/write ~/.clawgod/.claude.json instead of the
// native ~/.claude.json (the file holding MCP config, project history, session
// index). Move it back transparently on first run after upgrade.
const nativeClaudeJson = join(homedir(), '.claude.json');
const strayClaudeJson = join(clawgodDir, '.claude.json');
if (existsSync(strayClaudeJson) && !existsSync(nativeClaudeJson)) {
  try { renameSync(strayClaudeJson, nativeClaudeJson); } catch {}
}

const providerDir = clawgodDir;
const configFile = join(providerDir, 'provider.json');

const defaultConfig = {
  apiKey: '',
  baseURL: 'https://api.anthropic.com',
  model: '',
  smallModel: '',
  timeoutMs: 60000,
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

const hasProviderApiKey = !!config.apiKey;

if (hasProviderApiKey) {
  process.env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.baseURL) process.env.ANTHROPIC_BASE_URL = config.baseURL;
  if (config.model) process.env.ANTHROPIC_MODEL = config.model;
  if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
  if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
    process.env.ANTHROPIC_AUTH_TOKEN ??= config.apiKey;
  }
} else if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
  process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
}

if (config.timeoutMs) {
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
}
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
// Use system ripgrep (extracted vendor rg path was build-time-baked; system
// rg is the most reliable fallback under Bun runtime).
process.env.USE_BUILTIN_RIPGREP ??= '1';

// ─── 第三方 API 智能优化 ─────────────────────────────────
// 当检测到使用非 api.anthropic.com 的 baseURL 时，自动应用
// 第三方 API 兼容配置，避免 400 错误同时保持功能完整。
const isThirdParty = config.baseURL && !/anthropic\.com/i.test(config.baseURL);

if (isThirdParty) {
  // 1. 禁用 beta headers — 避免第三方 API 不认识的 beta 导致 400
  //    (NI6() 补丁已确保 Tool Search 不受此影响)
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1';

  // 2. 确保 Tool Search 启用（覆盖 DISABLE_EXPERIMENTAL_BETAS 的影响）
  process.env.ENABLE_TOOL_SEARCH ??= 'auto:0';

  // 3. 合理的超时（第三方 API 通常比官方慢）
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs || 120000);

  // 4. 流看门狗超时（慢响应不误判为断连）
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ??= '120000';
}

const featuresFile = join(providerDir, 'features.json');
if (!process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

require('./cli.original.cjs');

WRAPPER_EOF
chmod +x "$CLAWGOD_DIR/cli.cjs"
info "Wrapper created (cli.cjs)"

# ─── Write universal patcher ───────────────────────────

cat > "$CLAWGOD_DIR/patch.mjs" << 'PATCHER_EOF'
#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, 'cli.original.cjs');
const BACKUP = TARGET + '.bak';

// ─── Regex-based patches (version-agnostic) ──────────────

const patches = [
  {
    name: 'USER_TYPE → ant',
    pattern: /function ([\w$]+)\(\)\{return"external"\}/g,
    replacer: (m, fn) => `function ${fn}(){return"ant"}`,
    sentinel: 'return"external"',
  },
  {
    name: 'GrowthBook env overrides',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\)\2=!0;return ([\w$]+)\}/g,
    replacer: (m, fn, flag, val) =>
      `function ${fn}(){if(!${flag}){${flag}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    sentinel: ')Gq6=!0;return zTK}',  // unpatched form (v2.1.143 minified names)
    unique: true,  // must match exactly 1
  },
  {
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){try{return j8().growthBookOverrides??null}catch{return null}}${next}`,
    selectIndex: 0,  // first match only (there may be others)
    validate: (match, code) => {
      // Must be near other GrowthBook functions
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
    sentinel: 'growthBookOverrides',  // present after patching, absent in unpatched
    sentinelAbsence: true,  // sentinel absence means "not yet applied"
  },
  {
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: '"tengu_amber_flint",!0))return!1;return!0}',
  },
  {
    // ≤v2.1.142: function X(){let H=Y();return H==="max"||H==="pro"}
    // v2.1.143+: function Du(){if(Sdq!==null)return Sdq;if(!Hq())return!1;let H=z4();if(H==="max"||H==="pro")return!0;...}
    //   The v2.1.143 version already has caching and additional org role checks.
    //   We need to match both shapes and make the function return true.
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // v2.1.143+ has a different function shape (auto-bypasses via Hq() returning true)
  },
  {
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
    sentinel: '{enabled:!1,pixelValidation',
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // Patched shape: name:"ultraplan",...,isEnabled:()=>!0
    // Match all three so already-patched code reports "no change needed".
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!0|!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
  },
  {
    // ≤v2.1.110: function X(){return Y("tengu_review_bughunter_config",null)?.enabled===!0}
    // v2.1.119+: function X(){return Y("tengu_review_bughunter_config",null)} — getter
    //            and the gate at function Z(){return X()?.enabled===!0} elsewhere.
    //            We override the getter to always return {enabled:!0}.
    name: 'Ultrareview enable',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn) => `function ${fn}(){return{enabled:!0}}`,
    sentinel: '"tengu_review_bughunter_config"',
  },
  {
    name: 'Computer Use gate bypass',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\(\)&&[\w$]+\(\)\.enabled\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // may not exist in all versions
  },
  {
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // removed in v2.1.143+
  },
  {
    // ≤v2.1.110: let Y=Dq();if(Y!=="firstParty"&&Y!=="anthropicAws")return!1;return/^claude-(opus|sonnet)-4-6/.test(K)
    // v2.1.119+: same gate plus extra branches for claude-opus-4-7.
    // v2.1.139+: gate moved inside function wuH(H){let $=R7(H),q=Wq();if(q!=="firstParty"&&q!=="anthropicAws")return!1;if($.includes("claude-3-")||...)return!0;return!1}
    //            i.e. the `let` lifted to a comma-list before the if; the if-gate
    //            itself is unchanged shape. We drop only the if-gate; downstream
    //            model allow-list still runs and now accepts third-party calls.
    name: 'Auto-mode unlock for third-party API',
    pattern: /if\(([\w$]+)!=="firstParty"&&\1!=="anthropicAws"\)return!1;/g,
    replacer: () => '',
    sentinel: '!=="firstParty"&&',
  },
  {
    // CLI subcommand registered via commander chain:
    //   .command("update").alias("upgrade").description("…").action(async()=>{…})
    // The original action's update path is broken under clawgod: detectInstallType()
    // returns "unknown" because the launcher hides our cli.cjs from upstream's
    // path heuristics, and the unknown-fallback branch on macOS overwrites
    // ~/.bun/bin/bun by extracting the bun runtime out of the new native binary
    // (preserving Apr-19-build mtime). That **silently downgrades** clawgod's
    // required Bun and crashes cli.original.cjs the next launch with
    // "Expected CommonJS module to have a function wrapper". On Windows the
    // same fallback writes the new binary somewhere our drift detection
    // doesn't scan, so the user sees "Successfully updated" but never gets
    // the new version.
    //
    // Redirect to clawgod's own self-update so the upgrade goes through
    // install.sh (re-extract + re-patch + re-launcher). Always pull the
    // latest install.sh from the release so users get patcher fixes too.
    // Escape hatch printed on every run: `install.sh --uninstall` restores
    // claude.orig and lets vanilla `claude update` work again.
    name: "Redirect `claude update` to clawgod self-update",
    pattern: /(\.command\("update"\)\.alias\("upgrade"\)\.description\("[^"]+"\)\.action\(async\(\)=>\{)/g,
    replacer: (m, prefix) => {
      // PowerShell 5.1's Invoke-WebRequest ignores HTTP_PROXY/HTTPS_PROXY env
      // (only reads IE system proxy). Read env explicitly and pass via -Proxy
      // so it works on both PS 5.1 and PS 7. Use Invoke-RestMethod (irm) not
      // Invoke-WebRequest (iwr): under -UseBasicParsing on PS 5.1, iwr's
      // .Content is byte[] not string, so `iex (iwr -useb ...).Content`
      // throws "Cannot convert System.Byte[] to System.String". irm always
      // returns string in both versions. -EncodedCommand bypasses CLI
      // arg-quoting; payload must be UTF-16LE base64.
      const psScript =
        "$p=if($env:HTTPS_PROXY){$env:HTTPS_PROXY}elseif($env:HTTP_PROXY){$env:HTTP_PROXY}else{$null};" +
        "$u='https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.ps1';" +
        "if($p){iex(irm -Proxy $p $u)}else{iex(irm $u)}";
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      return (
        prefix +
        `process.stderr.write("[clawgod] 'claude update' is handled by clawgod self-update.\\n[clawgod] To leave clawgod and use vanilla update: bash ~/.clawgod/install.sh --uninstall\\n[clawgod] Continuing now\\u2026\\n");` +
        `var __cgW=process.platform==='win32';` +
        `var __cgCmd=__cgW?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.sh | bash'];` +
        `var __cgRes=require('child_process').spawnSync(__cgCmd[0],__cgCmd.slice(1),{stdio:'inherit'});` +
        `process.exit(__cgRes.status||0);`
      );
    },
    sentinel: '.command("update").alias("upgrade")',
  },
  // ── 模型默认值重定向 ──
  // Sub-agent 默认使用 MJ$() → MY().opus47（硬编码 claude-opus-4-7）
  // 第三方 API 用户需要子 Agent 继承主模型，改为优先读 ANTHROPIC_MODEL env var
  {
    name: 'Sub-agent model inherit from ANTHROPIC_MODEL',
    pattern: /function ([\w$]+)\(\)\{return MY\(\)\.(\w+)\}/g,
    replacer: (m, fn, modelKey) => `function ${fn}(){return process.env.ANTHROPIC_MODEL||MY().${modelKey}}`,
    selectIndex: 0,
    optional: true,
    sentinel: 'return MY().',
  },

  // ── 第三方 API 的 Tool Search 和特性启用 ──
  // pY() 检查 ANTHROPIC_BASE_URL 是否是 api.anthropic.com。
  // 第三方 API 用户 → pY()=false → Tool Search 被禁用 → skills/tools 无法动态加载
  // 改为始终返回 true，和 USER_TYPE="ant" 思想一致"假装在用官方 API"
  {
    name: 'Force pY() to always return true (enable Tool Search for 3rd party)',
    pattern: /function ([\w$]+)\(\)\{let H=process\.env\.ANTHROPIC_BASE_URL;if\(!H\)return!0;try\{let \$=new URL\(H\)\.host;return\["api\.anthropic\.com"\]\.includes\(\$\)\}catch\{return!1\}\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: 'ANTHROPIC_BASE_URL;if(!H)return!0;try{let $=new URL(H).host;return["api.anthropic.com"].includes($)}',
  },

  // ── ST() gate bypass for third-party API ──
  // v2.1.143: function ST(){return w86()} where w86() checks Dq()==="firstParty"/"anthropicAws"/"foundry".
  // We make ST() return true so features gated behind ST() (advisor, prompt caching, etc.)
  // work for third-party API users too.
  // Older v2.1.142 shape: function X(){return Y()&&!CH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)}
  // — matched by the old regex. v2.1.143 removed the DISABLE_EXPERIMENTAL_BETAS check.
  {
    name: 'Bypass ST() firstParty gate (enable features for 3rd party)',
    pattern: /function ST\(\)\{return [\w$]+\(\)\}/g,
    replacer: () => 'function ST(){return!0}',
    sentinel: 'function ST(){return w86()}',
  },
  // ── cI6()/dI6() Tool Search mode — remove DISABLE_EXPERIMENTAL_BETAS gate ──
  // v2.1.142: function cI6(){if(CH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=...}
  // v2.1.143: function dI6(){let H=process.env.ENABLE_TOOL_SEARCH;if(!H)return gI6;if(H==="auto")return gI6;let $=K$4(H);if($!==null)return $;return gI6}
  //   — DISABLE_EXPERIMENTAL_BETAS gate removed by upstream; function simplified.
  //   dI6() now returns a numeric percentage (gI6), not "standard"/"tst"/"tst-auto" strings.
  //   No patch needed for v2.1.143+.
  {
    name: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in cI6()/dI6() (enable Tool Search for 3rd party)',
    pattern: /function ([\w$]+)\(\)\{if\(CH\(process\.env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\)\)return"standard";let H=process\.env\.ENABLE_TOOL_SEARCH,\$=H\?([\w$]+)\(H\):null;if\(\$===0\)return"tst";if\(\$===100\)return"standard";if\(([\w$]+)\(H\)\)return"tst-auto";if\(CH\(H\)\)return"tst";if\(([\w$]+)\(process\.env\.ENABLE_TOOL_SEARCH\)\)return"standard";return"tst"\}/g,
    replacer: (m, fn, fnK, fnt15, fnI4) => `function ${fn}(){let H=process.env.ENABLE_TOOL_SEARCH,$=H?${fnK}(H):null;if($===0)return"tst";if($===100)return"standard";if(${fnt15}(H))return"tst-auto";if(CH(H))return"tst";if(${fnI4}(process.env.ENABLE_TOOL_SEARCH))return"standard";return"tst"}`,
    sentinel: 'DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=process.env.ENABLE_TOOL_SEARCH',
    optional: true,  // v2.1.143+ removed this gate entirely
  },

  // ── NI6() Tool Search mode — remove DISABLE_EXPERIMENTAL_BETAS gate ──
  // v2.1.110 shape: function NI6(){if(bH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";...}
  // v2.1.143: upstream removed DISABLE_EXPERIMENTAL_BETAS from this function entirely.
  //   dI6() now returns a numeric percentage (gI6 variable), not "standard"/"tst" strings.
  //   No patch needed for v2.1.143+, but keep the pattern for older versions.
  {
    name: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in NI6() (keep Tool Search enabled)',
    pattern: /function ([\w$]+)\(\)\{if\(bH\(process\.env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\)\)return"standard";let H=process\.env\.ENABLE_TOOL_SEARCH,\$=H\?WH4\(H\):null;if\(\$===0\)return"tst";if\(\$===100\)return"standard";if\(O95\(H\)\)return"tst-auto";if\(bH\(H\)\)return"tst";if\(E4\(process\.env\.ENABLE_TOOL_SEARCH\)\)return"standard";return"tst"\}/g,
    replacer: (m, fn) => `function ${fn}(){let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null;if($===0)return"tst";if($===100)return"standard";if(O95(H))return"tst-auto";if(bH(H))return"tst";if(E4(process.env.ENABLE_TOOL_SEARCH))return"standard";return"tst"}`,
    sentinel: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null',
    optional: true,  // v2.1.143+ removed this gate entirely
  },

  // ── API 请求层全量 beta 过滤 ──
  // 在 messages API 的 parse() 方法中，当 DISABLE_EXPERIMENTAL_BETAS=1 时，
  // 清空所有 anthropic-beta header，避免第三方 API 不认识的 beta 导致 400。
  // 同时也会阻止 beta 泄漏到请求体的 anthropic_beta 数组。
  {
    // Minified header-merge function name (Lq→Jq→etc) changes per build.
    // Match any valid JS identifier via capture group.
    name: 'Strip all beta headers in messages API when DISABLE_EXPERIMENTAL_BETAS=1',
    pattern: /parse\(H,\$\)\{return \$=\{\.\.\.\$,headers:([\w$]+)\(\[\{"anthropic-beta":\[\.\.\.H\.betas\?\?\[\],"structured-outputs-2025-12-15"\]\.toString\(\)\},\$\?\.headers\]\)\},this\.create\(H,\$\)\.then\(/g,
    replacer: (m, fn) => `parse(H,$){let _betas=process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?[]:[...H.betas??[],"structured-outputs-2025-12-15"];return $={...$,headers:${fn}([{"anthropic-beta":_betas.toString()},$?.headers])},this.create(H,$).then(`,
    sentinel: 'structured-outputs-2025-12-15"].toString()},$?.headers])},this.create(H,$).then(',
  },

  // ── web_search 对第三方 API 禁用 → 改用 web_fetch ──
  // web_search 是 Anthropic 服务器端工具，第三方 API 没有搜索后端。
  // 当检测到第三方 API 时，让 mt_() 返回 null（不注册该工具），
  // 同时确保 extraToolSchemas 中的 null 被过滤掉。
  {
    name: 'Disable web_search for third-party API',
    // Pattern uses [\w$]+ instead of mt_ to survive minifier renames across versions.
    // Sentinel checks for the unpatched form (function returning the object directly,
    // without the third-party guard). The patched form has an if-guard before return,
    // so this sentinel won't match after patching — correctly marking it "already applied".
    pattern: /function ([\w$]+)\(H\)\{return\{type:"web_search_20250305",name:"web_search",allowed_domains:H\.allowed_domains,blocked_domains:H\.blocked_domains,max_uses:8\}\}/g,
    replacer: (m, fn) => `function ${fn}(H){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return null;return{type:"web_search_20250305",name:"web_search",allowed_domains:H.allowed_domains,blocked_domains:H.blocked_domains,max_uses:8}}`,
    // Sentinel: the unpatched form starts with `(H){return{type:"web_search_20250305"...`.
    // After patching, it becomes `(H){if(process.env.ANTHROPIC_BASE_URL...return null;return{...}}`,
    // so this sentinel won't match — correctly detecting "already applied".
    sentinel: '(H){return{type:"web_search_20250305"',
  },
  {
    name: 'Filter null from extraToolSchemas',
    pattern: /r=\[\.\.\.A\.extraToolSchemas\?\?\[\]\]/g,
    replacer: () => 'r=[...A.extraToolSchemas??[]].filter(Boolean)',
    sentinel: 'r=[...A.extraToolSchemas??[]];',
  },

  // ── 绿色主题 (patch 标识) ──
  // Green theme patches change brand colors. After patching, the original
  // color strings are replaced, so sentinels detect the unpatched form.

  {
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /clawd_body:"rgb\(215,119,87\)"/g,
    replacer: () => 'clawd_body:"rgb(34,197,94)"',
    sentinel: 'clawd_body:"rgb(215,119,87)"',
  },
  {
    name: 'Logo + brand color → green (ANSI)',
    pattern: /clawd_body:"ansi:redBright"/g,
    replacer: () => 'clawd_body:"ansi:greenBright"',
    sentinel: 'clawd_body:"ansi:redBright"',
  },
  {
    name: 'Theme claude color → green (dark)',
    pattern: /claude:"rgb\(215,119,87\)"/g,
    replacer: () => 'claude:"rgb(34,197,94)"',
    sentinel: 'claude:"rgb(215,119,87)"',
  },
  {
    name: 'Theme claude color → green (light)',
    pattern: /claude:"rgb\(255,153,51\)"/g,
    replacer: () => 'claude:"rgb(22,163,74)"',
    sentinel: 'claude:"rgb(255,153,51)"',
  },
  {
    name: 'Shimmer → green',
    // v2.1.142: rgb(235,159,127) or rgb(245,149,117)
    // Both are orange/warm shimmer colors — replace with green
    pattern: /claudeShimmer:"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: () => 'claudeShimmer:"rgb(74,222,128)"',
    sentinel: 'claudeShimmer:"rgb(235,',
  },
  {
    name: 'Shimmer light → green',
    pattern: /claudeShimmer:"rgb\(255,183,101\)"/g,
    replacer: () => 'claudeShimmer:"rgb(34,197,94)"',
    sentinel: 'claudeShimmer:"rgb(255,183',
  },
  {
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
    sentinel: '#da7756',
  },

  // ── 限制移除 ──

  {
    name: 'Remove CYBER_RISK_INSTRUCTION',
    pattern: /([\w$]+)="IMPORTANT: Assist with authorized security testing[^"]*"/g,
    replacer: (m, varName) => `${varName}=""`,
    sentinel: 'Assist with authorized security testing',
  },
  {
    name: 'Remove URL generation restriction',
    pattern: /\n\$\{[\w$]+\}\nIMPORTANT: You must NEVER generate or guess URLs[^.]*\. You may use URLs provided by the user in their messages or local files\./g,
    replacer: () => '',
    sentinel: 'IMPORTANT: You must NEVER generate or guess URLs',
  },
  {
    name: 'Remove cautious actions section',
    // v2.1.88-~v2.1.122: function GSY(){return`# Executing actions...`}
    // v2.1.123+: function _j3(H){if(LE8(H)==="compact")return`# Executing...short`;return`# Executing...long`}
    pattern: /function ([\w$]+)\(([\w$]*)\)\{(?:if\([\s\S]{1,200}?\)return`# Executing actions with care\n\n[\s\S]*?`;)?return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn, arg) => `function ${fn}(${arg}){return\`\`}`,
    sentinel: '# Executing actions with care',
  },
  {
    name: 'Remove "Not logged in" notice',
    pattern: /Not logged in\. Run [\w ]+ to authenticate\./g,
    replacer: () => '',
    optional: true,
  },

  // ── 消息过滤 ──

  {
    // v2.1.88-~v2.1.91: fn()!=="ant"){if(q.attachment.type==="hook_additional_context"...
    // v2.1.92+        : fn()!=="ant"&&paY.has(q.attachment.type) — paY is an empty Set
    //                    in v2.1.110, so this filter is effectively a no-op; patch anyway
    //                    to guard against paY being populated in future versions.
    name: 'Attachment filter bypass',
    pattern: /([\w$]+)\(\)!=="ant"(&&[\w$]+\.has\([\w$]+\.attachment\.type\)|\)\{if\([\w$]+\.attachment\.type==="hook_additional_context")/g,
    replacer: (m) => m.replace(/([\w$]+)\(\)!=="ant"/, 'false'),
    optional: true,  // filter may be removed entirely in future versions
  },
  {
    // Legacy (≤v2.1.91) ternary form: fn()!=="ant"?tRY(_,sRY(K)):K
    name: 'Message list filter bypass (legacy ternary)',
    pattern: /([\w$]+)\(\)!=="ant"\?([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+)\)\):([\w$]+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => fallback,
    optional: true,  // removed in v2.1.92+
  },
  {
    // v2.1.92+ (s_8): if(fn()==="ant")return _;let z=...;return FaY(_,z)
    // Flip the guard so non-ant users also return the pre-filtered list.
    name: 'Message list filter bypass (s_8 form)',
    pattern: /if\(([\w$]+)\(\)==="ant"\)return ([\w$]+);let ([\w$]+)=([\w$]+) instanceof Set\?\4:([\w$]+)\(\4\);return ([\w$]+)\(\2,\3\)/g,
    replacer: (m, fn, ret) => `return ${ret}`,
    optional: true,  // legacy versions had a ternary instead
  },

  // ── WebSearch isEnabled() — 第三方 API 禁用 ──
  // Dq()/vq() 默认返回 "firstParty"（因为没有环境变量），
  // 导致 WebSearch 工具的 isEnabled() 返回 true，
  // 模型看到 web_search 工具定义 → 优先使用内置搜索而非 Tavily MCP。
  // 在 isEnabled() 开头添加 ANTHROPIC_BASE_URL 第三方检测，
  // 和 VH5() 中的检测逻辑保持一致（patch #20）。
  {
    name: 'Disable WebSearch isEnabled for third-party API',
    pattern: /isEnabled\(\)\{let H=([\w$]+)\(\);if\(H==="firstParty"\|\|H==="anthropicAws"\)return!0;if\(H==="gateway"\)return!1/g,
    replacer: (m, name) => `isEnabled(){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;let H=${name}();if(H==="firstParty"||H==="anthropicAws")return!0;if(H==="gateway")return!1`,
    sentinel: '!=="firstParty"&&!/anthropic',
    validate: (match, code) => {
      // Must be the WebSearch tool's isEnabled (with vertex/foundry fallthrough)
      const pos = code.indexOf(match);
      const lookahead = code.substring(pos + match.length, pos + match.length + 200);
      return lookahead.includes('vertex') && lookahead.includes('foundry');
    },
  },
  // ── 禁用第三方 API 的 outputFormat json_schema ──
  // Stop/SubagentStop hook evaluator 使用 outputFormat:{type:"json_schema"}
  // 强制模型返回严格 JSON。第三方 API 不认识此特性，忽略或错误处理，
  // 导致 q7(sx(response)) → null → "JSON validation failed"。
  // U2H() 决定模型是否支持 outputFormat，第三方 API 时让 U2H 返回 false，
  // mp5() 就不会注入 outputFormat。hook evaluator 的 prompt 中已包含
  // JSON 返回格式说明，模型仍会返回可解析的 JSON。
  {
    name: 'Disable outputFormat json_schema for third-party API',
    pattern: /function ([\w$]+)\(H\)\{let \$=[\w$]+\(H\),q=[\w$]+\(H\);if\(![\w$]+\(q\)\|\|q==="gateway"\)return!1;if\(\$\.includes\("claude-3-"\)\|\|\$==="claude-opus-4-0"\|\|\$==="claude-sonnet-4-0"\)return!1;return!0\}/g,
    replacer: (m, fn) => m.replace(`function ${fn}(H){`, `function ${fn}(H){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;`),
    sentinel: 'ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;let $',
    sentinelAbsence: true,  // sentinel presence = already patched
  },

  // ── 解锁第三方 API 的 Auto-Memory ──
  // ui$() (v2.1.143, was Pi$()) 是 auto-memory 系统的关键门禁函数：
  //   1. Z$("tengu_sepia_cormorant",null) → 如果 null（默认），返回 false
  //   2. 否则 iTK(modelName, allowlist) → 检查当前模型名是否在白名单中
  //   3. Z$("tengu_umber_petrel",!1) → 最终开关，默认 false
  // 第三方模型名不在 Anthropic 白名单 → ui$() 返回 false → x9() 关闭 auto-memory。
  // 补丁：让 ui$() 直接返回 true，auto-memory 对所有模型启用。
  // 注意：minifier 混淆名可能跨版本变化（v2.1.142: Pi$, v2.1.143: ui$），
  //   所以 pattern 使用 [\\w$]+ 通配符匹配函数名。
  {
    name: 'Enable auto-memory for third-party API (bypass model allowlist gate)',
    pattern: /function ([\w$]+)\(\)\{let H=[\w$]+\("tengu_sepia_cormorant",null\);if\(!Array\.isArray\(H\)\|\|H\.length===0\)return!1;let \$=[\w$]+\(\),q=\$!==void 0\?\$:[\w$]+\(\);if\(typeof q!=="string"\|\|![\w$]+\(q,H\)\)return!1;return [\w$]+\("tengu_umber_petrel",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: 'tengu_sepia_cormorant",null);if(!Array.isArray(H)',
  },

  // ── 解锁 memorySelector（auto-memory 内容注入）──
  // oo7() 是 memorySelector 函数，在用户输入时触发记忆搜索：
  //   条件：!K (no selector) || $.agentId (subagent) || !x9() (auto off) || !Z$("tengu_moth_copse",!1)
  //   最后一个条件：tengu_moth_copse 默认 false → 记忆内容指南不注入
  // 补丁：将 Z$("tengu_moth_copse",!1) 条件在 o7() 中始终为 true。
  // 注意：此补丁不易通过正则定位 oo7() 的具体调用，
  //   因此改用 features.json 设置 tengu_moth_copse: true。
  // 但 o7() 中的 !Z$("tengu_moth_copse",!1) 在 Z$() 的 default 为 !1，
  //   如果 GrowthBook 未提供该 flag，Z$() 返回 !1 → oo7() 提前 return。
  // 需要在 features.json 中添加 tengu_moth_copse: true。
  // 此处不加代码补丁，而是依赖 features.json 覆盖。

  // ── Fast Mode 解锁 — 第三方 API 用户无法使用 Fast Mode ──
  // Y9() (v2.1.143 minified name, was _9()) 是 Fast Mode 的启用检查：
  //   function Y9(){if(Dq()!=="firstParty")return!1;return!CH(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)}
  //   Dq() 默认返回 "firstParty"（无 Bedrock/Vertex 环境变量时），
  //   但 pY() 被我们改为 return!0 后，某些代码路径中 Dq() 可能被重新评估。
  //   直接让 Y9() 去掉 vq()/Dq() 检查，使 Fast Mode 对所有用户可用。
  //   保留 DISABLE_FAST_MODE 环境变量的控制。
  {
    name: 'Enable Fast Mode for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(([\w$]+)\(\)!=="firstParty"\)return!1;return!([\w$]+)\(process\.env\.CLAUDE_CODE_DISABLE_FAST_MODE\)\}/g,
    replacer: (m, fn, vqfn, bhfn) => `function ${fn}(){return!${bhfn}(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)}`,
    sentinel: '!=="firstParty")return!1;return!',  // sentinel is the removed vq check
  },

  // ── Advisor 工具解锁 — 第三方 API 用户无法使用 Advisor ──
  // uC() 是 Advisor 工具的启用检查：
  //   function uC(){if(bH(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL))return!1;if(vq()!=="firstParty"||!RT())return!1;...}
  //   RT() 已被 ST() bypass 补丁覆盖（返回 true），但 vq()!=="firstParty" 仍阻止第三方用户。
  //   移除 vq()!=="firstParty" 检查，同时保留 DISABLE_ADVISOR_TOOL 和 GrowthBook 控制。
  {
    name: 'Enable Advisor tool for third-party API',
    pattern: /if\(bH\(process\.env\.CLAUDE_CODE_DISABLE_ADVISOR_TOOL\)\)return!1;if\(vq\(\)!=="firstParty"\|\|!([\w$]+)\(\)\)return!1;/g,
    replacer: (m, fn) => 'if(bH(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL))return!1;',
    sentinel: 'DISABLE_ADVISOR_TOOL))return!1;if(vq()!=="firstParty"',
  },

  // ── Image Size Limit 提升 — 第三方 API 限制 5MB → 10MB ──
  // ac1() 决定图片大小限制：
  //   function ac1(){if(vq()==="firstParty"&&pY()&&Z$("tengu_crimson_vector",!1))return SxK;return Ql.maxBase64Size}
  //   只有 firstParty+pY()+tengu_crimson_vector 才返回 SxK(10MB)，否则 5MB。
  //   pY() 已补丁为 true，但 vq()==="firstParty" 对第三方 API 用户仍需通过。
  //   让第三方 API 用户也享受 10MB 限制。
  {
    name: 'Unlock 10MB image size limit for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(vq\(\)==="firstParty"&&([\w$]+)\(\)&&Z\$\("tengu_crimson_vector",!1\)\)return ([\w$]+);return ([\w$]+)\.maxBase64Size\}/g,
    replacer: (m, fn, pYfn, sxk, ql) => `function ${fn}(){if(${pYfn}()&&Z$("tengu_crimson_vector",!1))return ${sxk};return ${ql}.maxBase64Size}`,
    sentinel: 'vq()==="firstParty"&&',
  },

  // ── Send User File 工具解锁 — 第三方 API 用户无法发送文件给模型 ──
  // isEnabled(){if(vq()!=="firstParty"||f4())return!1;if(!Z$("tengu_send_user_file",!0))return!1;...}
  //   移除 vq()!=="firstParty" 检查。
  {
    name: 'Enable Send User File tool for third-party API',
    pattern: /isEnabled\(\)\{if\(vq\(\)!=="firstParty"\|\|([\w$]+)\(\)\)return!1;if\(!Z\$\("tengu_send_user_file",!0\)\)return!1;/g,
    replacer: (m, fn) => 'isEnabled(){if(!Z$("tengu_send_user_file",!0))return!1;',
    sentinel: 'vq()!=="firstParty"||',
    validate: (match, code) => code.indexOf('tengu_send_user_file') !== -1,
  },

  // ── 上下文窗口限制解除 — 第三方 API 默认 200k → 1M ──
  // EP(H,$) 返回模型上下文窗口大小：
  //   function EP(H,$){
  //     if(CH(DISABLE_COMPACT)&&process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS){...return K}
  //     if(lG(H))return 1e6;        // [1m] 标签
  //     if($?.includes(xU.header)&&Fc(H))return 1e6;  // beta header + model 检查
  //     if(OqH(H))return 1e6;        // opus-4-7
  //     let q=Zl$(H);if(q!==null)return q;  // kelp_forest_sonnet 缓存
  //     return M86                 // 默认 200000
  //   }
  //   对第三方模型（如 GLM-5.1），[1m] 标签不存在，beta header 也没有，
  //   最终返回 M86=200000。这导致：
  //   1. 自动压缩在 ~167k tokens 时触发（应该 980k）
  //   2. 上下文窗口显示错误（200k 而非 1M）
  //   3. 在第三方 API 下无法充分利用 1M 上下文
  //   修复：将 M86 默认值从 200000 改为 1000000
  {
    name: 'Raise default context window from 200k to 1M for third-party models',
    pattern: /var M86=200000/g,
    replacer: (m) => 'var M86=1000000',
    sentinel: 'var M86=200000',
  },

  // ── CLAUDE_CODE_MAX_CONTEXT_TOKENS 环境变量解锁 ──
  // EP 函数要求同时设置 DISABLE_COMPACT 才能使用 MAX_CONTEXT_TOKENS，
  // 这意味着用户要么禁用自动压缩，要么无法自定义上下文大小。
  // 修复：移除 DISABLE_COMPACT 前置条件，允许用户独立指定上下文大小。
  {
    name: 'Allow CLAUDE_CODE_MAX_CONTEXT_TOKENS without DISABLE_COMPACT',
    pattern: /if\([\w$]+\(process\.env\.DISABLE_COMPACT\)&&process\.env\.CLAUDE_CODE_MAX_CONTEXT_TOKENS\)\{/g,
    replacer: (m) => 'if(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS){',
    sentinel: 'DISABLE_COMPACT)&&process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  },

  // ── 1h Cache TTL 解锁 — 第三方 API 默认只有 5 分钟缓存 ──
  // ivH() 决定缓存 TTL 是否为 1h：
  //   function ivH(H){
  //     if(bH(FORCE_PROMPT_CACHING_5M))return!1;
  //     if(bH(ENABLE_PROMPT_CACHING_1H))return!0;    // 环境变量可以强制
  //     if(vq()==="bedrock"&&bH(ENABLE_PROMPT_CACHING_1H_BEDROCK))return!0;
  //     if(!qq()||bZ.isUsingOverage)return!1;          // ← 第三方被拦截
  //     let $=nv8();if($===null)$=Z$("tengu_prompt_cache_1h_config",{...}).allowlist;
  //     ...
  //   }
  //   qq() 检查 OAuth 认证状态，使用 ANTHROPIC_API_KEY 的第三方用户
  //   没有通过 OAuth 认证，导致 qq()=false，ivH() 返回 false。
  //   结果：第三方 API 只有 5 分钟缓存 TTL，而不是 1 小时。
  //   修复：跳过 qq() 和 isUsingOverage 的检查，让 GrowthBook flag 接管。
  {
    name: 'Unlock 1h cache TTL for third-party API (bypass auth gate)',
    pattern: /if\(!qq\(\)\|\|[\w$]+\.isUsingOverage\)return!1;/g,
    replacer: (m) => '/* patched: bypass auth check for 1h cache */if(!1)return!1;',
    sentinel: '!qq()||bZ.isUsingOverage)return!1;',
    validate: (match, code) => {
      // Only apply if this appears near tengu_prompt_cache_1h_config
      const idx = code.indexOf(match[0]);
      const nearby = code.substring(Math.max(0, idx - 300), idx + 300);
      return nearby.includes('tengu_prompt_cache_1h_config');
    },
  },

  // ── Global Cache Scope 解锁 — 第三方 API 缓存不跨会话共享 ──
  // FYH()（v2.1.142 为 SYH）决定缓存 scope 是否为 global：
  //   function FYH(){
  //     if(!ST())return!1;    // 实验性 beta（已补丁为 true）
  //     if(!xz())return!1;    // 已补丁为 true
  //     let H=Dq();return H==="firstParty"||H==="anthropicAws"  // ← 第三方被拦截
  //   }
  //   第三方 API 的 Dq()!=="firstParty" → FYH()=false → scope=undefined（本地缓存）
  //   结果：缓存只在当前请求内有效，不会跨会话持久化。
  //   修复：让 FYH() 对第三方模型也返回 true，启用 global scope。
  {
    name: 'Unlock global cache scope for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\(\)\)return!1;if\(!([\w$]+)\(\)\)return!1;let H=([\w$]+)\(\);return H==="firstParty"\|\|H==="anthropicAws"\}/g,
    replacer: (m, fn, rt, xz, dq) => `function ${fn}(){if(!${rt}())return!1;if(!${xz}())return!1;return!0}`,
    sentinel: 'H==="firstParty"||H==="anthropicAws"}',
  },
// ── Auto Mode (AFK Detection) 解锁 ──
  // $i() 是 auto-mode 启用检查：
  //   function $i(){
  //     if(rQ!==void 0)return rQ;
  //     if(v6H())return rQ=Ha(!0);           // GrowthBook feature flag
  //     if(Dq()==="gateway")return rQ=Ha(!0); // gateway 始终启用
  //     if(Dq()!=="firstParty")return rQ=Ha(!1);  ← 第三方被拦截
  //     if(!xz())return rQ=Ha(!1);           // 已补丁为 true
  //     if(process.env.CLAUDE_CODE_ENTRYPOINT==="local-agent")return rQ=Ha(!1);
  //     let H=xq();...OAuth/subscription checks...
  //   }
  //   第三方 API 即使 Dq() 返回 "firstParty"，后续的 OAuth/subscription
  //   检查仍然会阻止没有 OAuth token 的 API key 用户。
  //   补丁：移除 firstParty 检查、xz 检查（已补丁为true）和 local-agent 检查。
  {
    name: 'Unlock Auto Mode for third-party API',
    pattern: /if\([\w$]+\(\)!=="firstParty"\)return rQ=Ha\(!1\);if\(!xz\(\)\)return rQ=Ha\(!1\);if\(process\.env\.CLAUDE_CODE_ENTRYPOINT==="local-agent"\)return rQ=Ha\(!1\)/g,
    replacer: (m) => 'if(!xz())return rQ=Ha(!1)',
    sentinel: 'firstParty")return rQ=Ha(!1)',
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 100), pos + 100);
      return nearby.includes('rQ!==') || nearby.includes('v6H');
    },
  },

  // ── Channels 功能解锁 ──
  // qrH() 在 channels 注册时检查 provider：
  //   if(Dq()!=="firstParty")return{action:"skip",kind:"provider",
  //     reason:"channels are not available on third-party providers"}
  //   第三方 API 用户无法使用 MCP channels 功能。
  //   补丁：移除 firstParty 检查，允许第三方 API 使用 channels。
  {
    name: 'Unlock Channels for third-party API',
    pattern: /if\([\w$]+\(\)!=="firstParty"\)return\{action:"skip",kind:"provider",reason:"channels are not available on third-party providers"\}/g,
    replacer: (m) => '',
    sentinel: 'channels are not available on third-party providers',
  },

  // ── Model Migration 解锁 ──
  // Xe4() (legacy opus) 和 Ne4() (sonnet 4.5→4.6)
  // 都以 if(vq()!=="firstParty")return 开头，
  // 导致第三方 API 用户无法自动升级旧版模型设置。
  // 补丁：移除这两个函数的 firstParty 检查。
  // 使用 validate 区分 Opus 和 Sonnet 迁移函数。
  {
    name: 'Unlock legacy Opus model migration for third-party API',
    pattern: /function [\w$]+\(\)\{if\([\w$]+\(\)!=="firstParty"\)return;/g,
    replacer: (m) => m.replace(/if\([\w$]+\(\)!=="firstParty"\)return;/, ''),
    sentinel: '"claude-opus-4"',  // sentinel for opus migration context
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(pos, pos + 500);
      return nearby.includes('claude-opus-4');
    },
  },
  {
    name: 'Unlock Sonnet 4.5→4.6 migration for third-party API',
    pattern: /function [\w$]+\(\)\{if\([\w$]+\(\)!=="firstParty"\)return;/g,
    replacer: (m) => m.replace(/if\([\w$]+\(\)!=="firstParty"\)return;/, ''),
    sentinel: '"claude-sonnet-4-5"',  // sentinel for sonnet migration context
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(pos, pos + 500);
      return nearby.includes('claude-sonnet-4-5');
    },
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
console.log(`  Target: cli.original.cjs (v${version})`);
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

  // Uniqueness check — skip when 0 so the sentinel / already-applied
  // fallthrough can handle it; only fail on >1 (ambiguous).
  if (p.unique && relevant.length > 1) {
    console.log(`  ⚠️  ${p.name} — ${relevant.length} matches, skipping (need 1)`);
    failed++;
    continue;
  }

  if (relevant.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
      continue;
    }
    // If the patch declares a sentinel (a string that must NOT exist in a
    // fully-patched file), use it to tell "already applied" apart from
    // "regex is stale and silently missed the target".
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => code.includes(s));
      if (p.sentinelAbsence) {
        // sentinelAbsence: sentinel PRESENT means "already applied" (opposite of default)
        // e.g., "growthBookOverrides" only appears after patching
        if (stillPresent.length === sentinels.length) {
          console.log(`  ✅ ${p.name} (already applied, sentinel present)`);
          applied++;
        } else {
          console.log(`  ⚠️  ${p.name} (0 matches, sentinel absent — cannot verify)`);
          skipped++;
        }
      } else if (stillPresent.length > 0) {
        console.log(`  ❌ ${p.name} — regex stale, sentinel still in source: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++;
      } else {
        console.log(`  ✅ ${p.name} (already applied, sentinel absent)`);
        applied++;
      }
      continue;
    }
    console.log(`  ⚠️  ${p.name} (0 matches, no sentinel — cannot verify)`);
    skipped++;
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
  console.log(`  📝 Written: cli.original.cjs (${diff >= 0 ? '+' : ''}${diff} bytes)`);
}

console.log(`${'═'.repeat(55)}\n`);

PATCHER_EOF
info "Patcher created (patch.mjs)"

# ─── Apply patches ─────────────────────────────────────

dim "Applying patches ..."
node "$CLAWGOD_DIR/patch.mjs" 2>&1 | while IFS= read -r line; do echo "  $line"; done

# ─── Create default configs ───────────────────────────

if [ ! -f "$CLAWGOD_DIR/features.json" ]; then
  cat > "$CLAWGOD_DIR/features.json" << 'FEATURES_EOF'
{
  "tengu_harbor": false,
  "tengu_session_memory": false,
  "tengu_amber_flint": true,
  "tengu_auto_background_agents": false,
  "tengu_destructive_command_warning": true,
  "tengu_immediate_model_command": true,
  "tengu_desktop_upsell": false,
  "tengu_malort_pedway": {"enabled": true},
  "tengu_amber_quartz_disabled": false,
  "tengu_prompt_cache_1h_config": {"allowlist": ["*"]},
  "tengu_moth_copse": true,
  "tengu_umber_petrel": true,
  "tengu_sepia_cormorant": ["claude", "deepseek", "qwen", "gpt", "gemini", "o1", "o3", "o4"],
  "tengu_sedge_lantern": true,
  "tengu_billiard_aviary": false
}

FEATURES_EOF
  info "Default features.json created"
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

LAUNCHER_CONTENT="#!/bin/bash
# clawgod launcher
CLAWGOD_CLI=\"$CLAWGOD_DIR/cli.cjs\"
BUN_BIN=\"$BUN_BIN\"
if [ ! -f \"\$CLAWGOD_CLI\" ]; then
  echo \"clawgod: installation at $CLAWGOD_DIR is missing (cli.cjs not found)\" >&2
  echo \"clawgod: reinstall via  curl -fsSL https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.sh | bash\" >&2
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
exec \"\$BUN_BIN\" \"\$CLAWGOD_CLI\" \"\$@\""

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
dim "  in one step. To leave clawgod and use vanilla update:"
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
