#Requires -Version 5.1
<#
.SYNOPSIS
    ClawGod Installer for Windows
.DESCRIPTION
    Downloads Claude Code from npm, applies feature unlock patches,
    and replaces the 'claude' command with the patched version.
.EXAMPLE
    irm clawgod.0chen.cc/install.ps1 | iex
    # or
    .\install.ps1
    .\install.ps1 -Version 2.1.89
    .\install.ps1 -NoUpgrade
    .\install.ps1 -Uninstall
#>
param(
    [string]$Version = "latest",
    [switch]$NoUpgrade,
    [switch]$Uninstall,
    [switch]$LeanOff,
    [switch]$LeanOn,
    [switch]$LeanMax
)

$ErrorActionPreference = "Stop"

if ($env:CLAWGOD_VERSION -and $Version -eq "latest") { $Version = $env:CLAWGOD_VERSION }
if ($env:CLAWGOD_NO_UPGRADE -eq "1") { $NoUpgrade = [switch]$true }
if ($env:CLAWGOD_LEAN_OFF -eq "1") { $LeanOff = [switch]$true }
if ($env:CLAWGOD_LEAN_ON -eq "1") { $LeanOn = [switch]$true }
if ($env:CLAWGOD_LEAN_MAX -eq "1") { $LeanMax = [switch]$true }

$ClawDir = Join-Path $env:USERPROFILE ".clawgod"
$BinDir  = Join-Path $env:USERPROFILE ".local\bin"
$ClawSelfVersion = "0.0.0-dev"  # injected by release workflow from git tag

# ─── Colors ───────────────────────────────────────────

function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Dim($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ClawGod Installer" -ForegroundColor White -NoNewline
Write-Host " (Windows)" -ForegroundColor DarkGray
Write-Host ""

# ─── Uninstall ────────────────────────────────────────

if ($Uninstall) {
    # Restore original claude
    $claudeOrig = Join-Path $BinDir "claude.orig.cmd"
    $claudeCmd  = Join-Path $BinDir "claude.cmd"
    if (Test-Path $claudeOrig) {
        Move-Item -Force $claudeOrig $claudeCmd
        Write-OK "Original claude restored"
    } elseif ((Test-Path $claudeCmd) -and (Select-String -Path $claudeCmd -Pattern "clawgod" -Quiet -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $claudeCmd
        Write-OK "Removed ClawGod launcher ($claudeCmd)"
    }
    # Also check for .exe backup
    $claudeExeOrig = Join-Path $BinDir "claude.orig.exe"
    $claudeExe     = Join-Path $BinDir "claude.exe"
    if (Test-Path $claudeExeOrig) {
        Move-Item -Force $claudeExeOrig $claudeExe
        Write-OK "Original claude.exe restored"
    }
    # Remove explicit clawgod alias
    $clawgodCmd = Join-Path $BinDir "clawgod.cmd"
    if (Test-Path $clawgodCmd) {
        Remove-Item -Force $clawgodCmd
        Write-OK "Removed clawgod alias"
    }

    foreach ($f in @("cli.js","cli.cjs","cli.original.js","cli.original.cjs","cli.original.js.bak","cli.original.cjs.bak","patch.js","patch.mjs","extract-natives.mjs","post-process.mjs","repatch.mjs","openai-proxy.cjs","clawgod-import.exe",".source-version","node_modules","bun-runtime","vendor","bunfs","pathmap.json")) {
        $p = Join-Path $ClawDir $f
        if (Test-Path $p) { Remove-Item -Recurse -Force $p }
    }
    Write-OK "ClawGod uninstalled"
    Write-Host ""
    Write-Dim "Restart your terminal for changes to take effect."
    Write-Host ""
    exit 0
}

# ─── Prerequisites ────────────────────────────────────

try { $null = Get-Command node -ErrorAction Stop }
catch {
    Write-Err "Node.js is required (>= 18) for the patcher. Install from https://nodejs.org"
    exit 1
}

$nodeVer = [int](node -e "console.log(process.versions.node.split('.')[0])")
if ($nodeVer -lt 18) {
    Write-Err "Node.js >= 18 required (found v$nodeVer)"
    exit 1
}

# ─── Ensure Bun (runtime that executes the patched cli.js) ────────────

$BunBin = $null
try { $BunBin = (Get-Command bun -ErrorAction Stop).Source } catch {}
if (-not $BunBin) {
    $homeBun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $homeBun) { $BunBin = $homeBun }
}
if (-not $BunBin) {
    Write-Dim "Installing Bun (required runtime for v2.1.113+ cli.js) ..."
    try {
        Invoke-Expression "$(Invoke-RestMethod https://bun.sh/install.ps1)" 2>$null | Out-Null
    } catch {}
    $BunBin = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (-not (Test-Path $BunBin)) {
        Write-Err "Bun installation failed. Install manually: https://bun.sh/install"
        exit 1
    }
}

# Resolve bun.ps1 → bun.exe. When Bun is installed via `npm install -g bun`,
# Get-Command returns a .ps1 wrapper script. A .cmd launcher cannot invoke .ps1
# directly — Windows opens the file association dialog instead of executing it.
# Probe known install paths instead of parsing wrapper scripts.
if ($BunBin -and $BunBin -match '\.ps1$') {
    $resolved = $null
    $bunDir = Split-Path $BunBin
    # 1. npm global: bun.ps1 sits next to node_modules/bun/bin/bun.exe
    $cand = Join-Path $bunDir "node_modules\bun\bin\bun.exe"
    if (Test-Path $cand) { $resolved = $cand }
    # 2. bun.sh official install
    if (-not $resolved) {
        $cand = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
        if (Test-Path $cand) { $resolved = $cand }
    }
    # 3. Scoop: shim exe lives in ~/scoop/shims/
    if (-not $resolved) {
        $cand = Join-Path $env:USERPROFILE "scoop\shims\bun.exe"
        if (Test-Path $cand) { $resolved = $cand }
    }
    # 4. Chocolatey: typically in C:\ProgramData\chocolatey\bin\
    if (-not $resolved) {
        $chocoBin = Join-Path $env:ProgramData "chocolatey\bin\bun.exe"
        if (Test-Path $chocoBin) { $resolved = $chocoBin }
    }
    if ($resolved) {
        Write-Dim "Resolved bun.ps1 → $resolved"
        $BunBin = $resolved
    } else {
        Write-Warn "Bun resolved to .ps1 wrapper ($BunBin). The launcher may not work."
        Write-Warn "Consider installing Bun via bun.sh/install.ps1 for a native bun.exe."
    }
}
Write-OK "Bun: $(& $BunBin --version)"

# ─── Bun version pre-flight ───────────────────────────────────────────
# Anthropic builds the native binary with Bun's canary channel; stable
# bun.sh trails by one version. Bun < 1.3.14 panics on cli.original.cjs
# with "Expected CommonJS module to have a function wrapper". Refuse
# early — no npm download / no patch / no late sanity surprise where
# PowerShell's NativeCommandError display buries the friendly message.
# Bump $MinBunVersion when Anthropic moves the embedded Bun forward
# again.

$MinBunVersion = '1.3.14'
$BunVersionRaw = ''
try {
    $bunOut = & $BunBin --version 2>$null | Select-Object -First 1
    if ($bunOut) { $BunVersionRaw = "$bunOut".Trim() }
} catch {}
$BunVersionNum = ($BunVersionRaw -split '-')[0]
$BunVersionOk = $false
try {
    if ($BunVersionNum) {
        $BunVersionOk = ([version]$BunVersionNum) -ge ([version]$MinBunVersion)
    }
} catch {}
if (-not $BunVersionOk) {
    Write-Host ""
    Write-Err "Bun $BunVersionRaw is below the required minimum ($MinBunVersion)."
    Write-Err ""
    Write-Err "  Anthropic builds claude-code with Bun's canary channel. Older Bun"
    Write-Err "  panics on cli.original.cjs with 'Expected CommonJS module to have"
    Write-Err "  a function wrapper'. This is a hard requirement, not a warning."
    Write-Err ""
    Write-Err "  Upgrade with one of:"
    Write-Err "    bun upgrade --canary"
    Write-Err "    powershell -c ""iex & {`$(irm https://bun.sh/install.ps1)} -Version canary"""
    Write-Err ""
    Write-Err "  If your bun is from scoop (the binary is behind a shim and refuses"
    Write-Err "  to self-replace, so 'bun upgrade' silently hangs):"
    Write-Err "    scoop uninstall bun"
    Write-Err "    irm https://bun.sh/install.ps1 | iex"
    Write-Err "    bun upgrade --canary"
    Write-Err ""
    Write-Err "  Then re-run this installer."
    exit 1
}

# ─── ripgrep prerequisite (search/grep tool) ──────────────────────────
# Hard prerequisite — without rg the Grep tool inside Claude Code fails.

try {
    $rgPath = (Get-Command rg -ErrorAction Stop).Source
    Write-OK "ripgrep: $rgPath"
}
catch {
    Write-Err "ripgrep (rg) is required but not found in PATH."
    Write-Err "  Claude Code's Grep tool will not function without it."
    Write-Err ""
    Write-Err "  Install: winget install BurntSushi.ripgrep.MSVC"
    Write-Err "       or: scoop install ripgrep"
    Write-Err "       or: choco install ripgrep"
    Write-Err ""
    Write-Err "  Re-run this script after installing rg."
    exit 1
}

# ─── Handle -NoUpgrade (skip download, re-patch only) ────────────────
if ($NoUpgrade) {
    New-Item -ItemType Directory -Force -Path $ClawDir | Out-Null
    New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null
    $existingCjs = Join-Path $ClawDir "cli.original.cjs"
    $existingBak = "$existingCjs.bak"
    if (-not (Test-Path $existingCjs)) {
        Write-Err "-NoUpgrade requires an existing installation."
        Write-Err "Run a full install first (without -NoUpgrade)."
        exit 1
    }
    if (Test-Path $existingBak) {
        Copy-Item $existingBak $existingCjs -Force
        Write-OK "Restored clean cli.original.cjs from backup"
    }
    Write-OK "Skipping download (-NoUpgrade)"
} else {

# ─── Locate native Bun binary (cli.js source) ──────────────────────────
# Source: npm registry (@anthropic-ai/claude-code-win32-<arch>).
# Local binary detection is intentionally skipped — see policy note below.

New-Item -ItemType Directory -Force -Path $ClawDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null

$NativeBin = $null
$NativeBinLabel = $null
$NativeBinTmpDir = $null

# Detect platform suffix
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    $arch = "arm64"
} else {
    $arch = "x64"
}
$platformSuffix = "win32-$arch"

# Detection policy: ALWAYS pull from the npm registry @latest.
#
# Earlier versions of this script also probed local install directories
# (versions/, claude.orig, npm-global, bun-global) before falling back to
# the registry. Every one of those is a stale-source trap: clawgod patches
# out `claude update`, so users never re-run the underlying installers,
# and those directories freeze at whatever version was on disk the day
# clawgod was first installed. `claude update` (which is now redirected
# here) would re-detect the frozen binary forever — never reaching the
# registry. See INCIDENT_LOG 2026-04-29 entry. The fix is to skip local
# detection entirely; the npm tarball is ~60-90 MB compressed, fetched
# once per upgrade.

# npm registry — pull the platform tarball directly via Node.
#    Avoids depending on `npm` and `tar` being on PATH (older Windows 10
#    builds lack tar.exe; some PowerShell shims mangle `& npm`). Node is
#    already a hard prerequisite for the patcher, so reuse it.
if (-not $NativeBin) {
    $npmPkg = "@anthropic-ai/claude-code-$platformSuffix"
    Write-Dim "Fetching $npmPkg@$Version from npm registry ..."
    $NativeBinTmpDir = Join-Path $env:TEMP "clawgod-binary-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $NativeBinTmpDir | Out-Null
    $fetchScript = Join-Path $NativeBinTmpDir "fetch.mjs"
    $useNpmFetch = $false
    $noProxy = $env:NO_PROXY
    if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
        if ($noProxy -match '(?i)npmjs\.org') {
            Write-Dim "NO_PROXY includes npmjs.org — using direct fetch"
        } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
            $useNpmFetch = $true
        } else {
            Write-Warn "HTTP proxy detected but npm not found. fetch.mjs may not work through your proxy."
            Write-Warn "Install npm or set NO_PROXY=registry.npmjs.org to bypass."
        }
    }
    if ($useNpmFetch) {
        Push-Location $NativeBinTmpDir
        try {
            $npmOut = npm pack "$npmPkg@$Version" --silent 2>&1
            $tarball = Get-ChildItem $NativeBinTmpDir -Filter "*.tgz" | Select-Object -First 1
            if ($tarball) {
                tar xzf $tarball.FullName 2>$null
                $cand = Join-Path $NativeBinTmpDir "package\claude.exe"
                if ((Test-Path $cand) -and (Get-Item $cand).Length -gt 10MB) {
                    $NativeBin = $cand
                    $pkgJson = Join-Path $NativeBinTmpDir "package\package.json"
                    if (Test-Path $pkgJson) {
                        $NativeBinLabel = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version
                    } else { $NativeBinLabel = "npm-latest" }
                    Write-OK "Downloaded $npmPkg@$NativeBinLabel (via npm)"
                }
            }
        } finally { Pop-Location }
        if (-not $NativeBin) {
            Remove-Item -Recurse -Force $NativeBinTmpDir -ErrorAction SilentlyContinue
            Write-Err "npm pack failed. Output:"
            Write-Dim ($npmOut -join "`n")
            exit 1
        }
    } else {
    @'
// Download a scoped npm tarball (no npm CLI dependency) and extract it
// using Node's built-in zlib + a minimal POSIX tar parser.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';

const [, , pkgSpec, outDir] = process.argv;
const last = pkgSpec.lastIndexOf('@');
const pkg = last > 0 ? pkgSpec.slice(0, last) : pkgSpec;
const ver = last > 0 ? pkgSpec.slice(last + 1) : 'latest';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error(`Too many redirects`));
    const parsed = new URL(url);
    const reqMod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const opts = { method: 'GET', hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search };
    reqMod(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}

const metaBuf = await get(`https://registry.npmjs.org/${pkg}/${ver}`);
const meta = JSON.parse(metaBuf.toString('utf8'));
console.log(`Resolved ${pkg}@${meta.version}`);
const tgz = await get(meta.dist.tarball);
console.log(`Downloaded ${(tgz.length / 1024 / 1024).toFixed(1)} MB`);

const buf = gunzipSync(tgz);
mkdirSync(outDir, { recursive: true });
let off = 0, files = 0;
while (off + 512 <= buf.length) {
  const name = buf.slice(off, off + 100).toString('utf8').replace(/\0+$/, '');
  if (!name) break;
  const sizeOct = buf.slice(off + 124, off + 136).toString('utf8').replace(/[\0\s]+$/, '');
  const size = parseInt(sizeOct, 8) || 0;
  const typeflag = String.fromCharCode(buf[off + 156]);
  off += 512;
  if (typeflag === '0' || typeflag === '\0') {
    const dest = join(outDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf.slice(off, off + size));
    files++;
  }
  off += Math.ceil(size / 512) * 512;
}
console.log(`Extracted ${files} files`);
console.log(`VERSION=${meta.version}`);
'@ | Set-Content $fetchScript -Encoding UTF8

        $output = & node $fetchScript "$npmPkg@$Version" $NativeBinTmpDir 2>&1
        $exitCode = $LASTEXITCODE
        $output | ForEach-Object { Write-Host "  $_" }
        Remove-Item -Force $fetchScript -ErrorAction SilentlyContinue

        if ($exitCode -ne 0) {
            Remove-Item -Recurse -Force $NativeBinTmpDir -ErrorAction SilentlyContinue
            Write-Err "Fetch failed (node exit $exitCode). Install the official binary manually:"
            Write-Err "    irm https://claude.ai/install.ps1 | iex"
            exit 1
        }

        $cand = Join-Path $NativeBinTmpDir "package\claude.exe"
        if ((Test-Path $cand) -and (Get-Item $cand).Length -gt 10MB) {
            $NativeBin = $cand
            $verLine = $output | Where-Object { $_ -match '^VERSION=' } | Select-Object -First 1
            if ($verLine) { $NativeBinLabel = ($verLine -replace '^VERSION=', '').Trim() }
            else { $NativeBinLabel = "npm-latest" }
        } else {
            Remove-Item -Recurse -Force $NativeBinTmpDir -ErrorAction SilentlyContinue
            Write-Err "Tarball downloaded but expected package\claude.exe was missing or too small."
            Write-Err "  Tempdir kept for inspection: $NativeBinTmpDir"
            exit 1
        }
        Write-OK "Downloaded $npmPkg@$NativeBinLabel"
    }
}

if (-not $NativeBin) {
    Write-Err "Native Claude Code binary not found"
    Write-Err "Install the official binary first:"
    Write-Err "  irm https://claude.ai/install.ps1 | iex"
    Write-Err "Then re-run this script."
    exit 1
}

# Always write the extractor (used for cli.js and/or .node modules)
$extractorPath = Join-Path $ClawDir "extract-natives.mjs"
@'
#!/usr/bin/env node
/**
 * ClawGod Bun section extractor
 *
 * Parses the .bun (PE/ELF) or __BUN,__bun (Mach-O) section embedded in a
 * Bun standalone executable, walks the module graph, and extracts:
 *   - the entry-point module      → <out>/cli.original.js
 *   - every loader=napi module    → <out>/vendor/<name>/<arch>-<os>/<name>.node
 *
 * Everything else is dropped (e.g. auto-generated *.js napi shims aren't
 * needed because cli.js already inlines the require('/$bunfs/root/X.node')
 * calls that post-process.mjs rewrites to the vendor lookup).
 *
 * Adapted from /home/kaiju/code/python/parse-bun/main.js (which itself
 * implements the format documented in docs/bun-section-format.md). Lazy
 * Bun.file reads were replaced with readFileSync so the script runs under
 * the existing `node` invocation in install.sh / install.ps1.
 *
 * Usage:
 *   node extract-natives.mjs <binary-path> <output-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Format constants ────────────────────────────────────────────────

const TRAILER             = Buffer.from('\n---- Bun! ----\n');
const BUN_SECTION_NAME    = '.bun';
const OFFSET_STRUCT_SIZE  = 32;
const MODULE_RECORD_SIZE  = 52;

// loader id → name (subset; only `napi` is acted on, rest informational)
const LOADERS = {
  0:'jsx', 1:'js', 2:'ts', 3:'tsx', 4:'css', 5:'file', 6:'json', 7:'jsonc',
  8:'toml', 9:'wasm', 10:'napi', 11:'base64', 12:'dataurl', 13:'text',
  14:'bunsh', 15:'sqlite', 16:'sqlite_embedded', 17:'html', 18:'yaml',
  19:'json5', 20:'md',
};

// ELF
const ELF_MAGIC_LE          = 0x464c457f; // "\x7fELF" LE u32
const ELF_EI_CLASS          = 0x04;
const ELF_EI_DATA           = 0x05;
const ELF_CLASS_64          = 0x02;
const ELF_DATA_LE           = 0x01;
const ELF_E_MACHINE         = 0x12;       // u16
const ELF_EHDR_SIZE         = 0x40;
const ELF64_E_SHOFF         = 0x28;
const ELF64_E_SHENTSIZE     = 0x3a;
const ELF64_E_SHNUM         = 0x3c;
const ELF64_E_SHSTRNDX      = 0x3e;
const ELF64_SH_NAME         = 0x00;
const ELF64_SH_OFFSET       = 0x18;
const ELF64_SH_SIZE         = 0x20;
const EM_X86_64             = 0x3e;
const EM_AARCH64            = 0xb7;

// Mach-O (thin LE 64-bit; fat / 32-bit / BE rejected with clear message)
const MH_MAGIC_64           = 0xfeedfacf;
const MH_CIGAM_64           = 0xcffaedfe;
const MH_MAGIC              = 0xfeedface;
const MH_CIGAM              = 0xcefaedfe;
const MACH_CPUTYPE_OFF      = 0x04;        // u32
const MACH_NCMDS_OFF        = 0x10;
const MACH_SIZEOFCMDS_OFF   = 0x14;
const MACH_HDR_SIZE_64      = 0x20;
const LC_SEGMENT_64         = 0x19;
const LC_CMDSIZE_OFF        = 0x04;
const LC_SEGNAME_OFF        = 0x08;
const LC_SEGNAME_LEN        = 0x10;
const SEG64_NSECTS_OFF      = 0x40;
const SEG64_SECTS_OFF       = 0x48;
const SECT64_ENTRY_SIZE     = 0x50;
const SECT64_SIZE_OFF       = 0x28;
const SECT64_OFFSET_OFF     = 0x30;
const CPU_TYPE_X86_64       = 0x01000007;
const CPU_TYPE_ARM64        = 0x0100000c;

// PE
const PE_OFFSET_PTR         = 0x3c;
const PE_MACHINE_OFF        = 0x04;       // relative to PE sig
const PE_NUM_SECTIONS_OFF   = 0x06;
const PE_OPT_HDR_SIZE_OFF   = 0x14;
const PE_COFF_HDR_SIZE      = 0x18;
const PE_OPT_MAGIC_OFF      = 0x18;
const PE_OPT_MAGIC_PE32P    = 0x20b;
const PE_SECTION_ENTRY_SIZE = 0x28;
const PE_SECT_RAW_SIZE_OFF  = 0x10;
const PE_SECT_RAW_OFF_OFF   = 0x14;
const PE_SECT_NAME_LEN      = 0x08;
const IMAGE_MACHINE_AMD64   = 0x8664;
const IMAGE_MACHINE_ARM64   = 0xaa64;

// ─── Helpers ─────────────────────────────────────────────────────────

function die(msg) { throw new Error(`error: ${msg}`); }

function readU64LE(buf, off, what) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) die(`${what} exceeds JS safe integer: ${v}`);
  return Number(v);
}

function checkedSlice(buf, off, size, what) {
  if (off < 0 || size < 0 || off + size > buf.length) {
    die(`${what} out of bounds: offset=${off} size=${size} buf=${buf.length}`);
  }
  return buf.subarray(off, off + size);
}

function decodeName(buf) {
  return buf.toString('utf8').replace(/\u0000+$/u, '');
}

// ─── Section locators (per format) ───────────────────────────────────

function findSectionElf(buf) {
  if (buf.length < ELF_EHDR_SIZE) die('ELF too small');
  if (buf[ELF_EI_CLASS] !== ELF_CLASS_64) die('ELF: only 64-bit supported');
  if (buf[ELF_EI_DATA]  !== ELF_DATA_LE) die('ELF: only little-endian supported');

  const eMachine = buf.readUInt16LE(ELF_E_MACHINE);
  const arch = eMachine === EM_X86_64  ? 'x64'
             : eMachine === EM_AARCH64 ? 'arm64'
             : die(`ELF: unsupported e_machine 0x${eMachine.toString(16)}`);

  const shoff     = readU64LE(buf, ELF64_E_SHOFF, 'ELF e_shoff');
  const shentsize = buf.readUInt16LE(ELF64_E_SHENTSIZE);
  const shnum     = buf.readUInt16LE(ELF64_E_SHNUM);
  const shstrndx  = buf.readUInt16LE(ELF64_E_SHSTRNDX);
  if (shstrndx >= shnum) die('ELF e_shstrndx out of range');

  const shstrEntry  = buf.subarray(shoff + shstrndx * shentsize, shoff + (shstrndx + 1) * shentsize);
  const shstrOffset = readU64LE(shstrEntry, ELF64_SH_OFFSET, 'shstrtab offset');
  const shstrSize   = readU64LE(shstrEntry, ELF64_SH_SIZE,   'shstrtab size');
  const shstr       = checkedSlice(buf, shstrOffset, shstrSize, 'shstrtab');

  let match = null;
  for (let i = 0; i < shnum; i++) {
    const entry   = buf.subarray(shoff + i * shentsize, shoff + (i + 1) * shentsize);
    const nameIdx = entry.readUInt32LE(ELF64_SH_NAME);
    if (nameIdx >= shstr.length) continue;
    let nameEnd = nameIdx;
    while (nameEnd < shstr.length && shstr[nameEnd] !== 0) nameEnd++;
    if (shstr.toString('ascii', nameIdx, nameEnd) !== BUN_SECTION_NAME) continue;
    if (match) die('ELF has multiple .bun sections');
    const rawOffset = readU64LE(entry, ELF64_SH_OFFSET, '.bun sh_offset');
    const rawSize   = readU64LE(entry, ELF64_SH_SIZE,   '.bun sh_size');
    if (rawOffset + rawSize > buf.length) die('.bun out of file bounds');
    match = { format: 'ELF', os: 'linux', arch, rawOffset, rawSize };
  }
  if (!match) die('ELF has no .bun section');
  return match;
}

function findSectionMacho(buf) {
  if (buf.length < MACH_HDR_SIZE_64) die('Mach-O too small');
  const cputype = buf.readUInt32LE(MACH_CPUTYPE_OFF);
  const arch = cputype === CPU_TYPE_X86_64 ? 'x64'
             : cputype === CPU_TYPE_ARM64  ? 'arm64'
             : die(`Mach-O: unsupported cputype 0x${cputype.toString(16)}`);

  const ncmds      = buf.readUInt32LE(MACH_NCMDS_OFF);
  const sizeofcmds = buf.readUInt32LE(MACH_SIZEOFCMDS_OFF);
  if (sizeofcmds === 0 || MACH_HDR_SIZE_64 + sizeofcmds > buf.length) die('Mach-O sizeofcmds invalid');
  const cmds = buf.subarray(MACH_HDR_SIZE_64, MACH_HDR_SIZE_64 + sizeofcmds);

  let match = null;
  let off = 0;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > sizeofcmds) die(`Mach-O LC ${i} truncated`);
    const cmd     = cmds.readUInt32LE(off);
    const cmdsize = cmds.readUInt32LE(off + LC_CMDSIZE_OFF);
    if (cmdsize < 8 || off + cmdsize > sizeofcmds) die(`Mach-O LC ${i} cmdsize invalid: ${cmdsize}`);
    if (cmd === LC_SEGMENT_64) {
      const segname = cmds.toString('ascii', off + LC_SEGNAME_OFF, off + LC_SEGNAME_OFF + LC_SEGNAME_LEN).replace(/\0+$/, '');
      if (segname === '__BUN') {
        const nsects = cmds.readUInt32LE(off + SEG64_NSECTS_OFF);
        if (SEG64_SECTS_OFF + nsects * SECT64_ENTRY_SIZE > cmdsize) die(`Mach-O LC_SEGMENT_64(__BUN) sections exceed cmdsize`);
        for (let j = 0; j < nsects; j++) {
          const s = off + SEG64_SECTS_OFF + j * SECT64_ENTRY_SIZE;
          const sectname = cmds.toString('ascii', s, s + LC_SEGNAME_LEN).replace(/\0+$/, '');
          if (sectname === '__bun') {
            const rawSize   = readU64LE(cmds, s + SECT64_SIZE_OFF, '__bun size');
            const rawOffset = cmds.readUInt32LE(s + SECT64_OFFSET_OFF);
            if (rawOffset + rawSize > buf.length) die('__bun out of file bounds');
            if (match) die('Mach-O has multiple __BUN,__bun sections');
            match = { format: 'Mach-O', os: 'darwin', arch, rawOffset, rawSize };
          }
        }
      }
    }
    off += cmdsize;
  }
  if (!match) die('Mach-O has no __BUN,__bun section');
  return match;
}

function findSectionPe(buf) {
  if (buf.length < 0x40) die('PE too small');
  if (buf.toString('ascii', 0, 2) !== 'MZ') die('PE missing MZ header');
  const peOff = buf.readUInt32LE(PE_OFFSET_PTR);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') die('PE missing PE signature');

  const machine = buf.readUInt16LE(peOff + PE_MACHINE_OFF);
  const arch = machine === IMAGE_MACHINE_AMD64 ? 'x64'
             : machine === IMAGE_MACHINE_ARM64 ? 'arm64'
             : die(`PE: unsupported machine 0x${machine.toString(16)}`);

  const optMagic = buf.readUInt16LE(peOff + PE_OPT_MAGIC_OFF);
  if (optMagic !== PE_OPT_MAGIC_PE32P) die(`PE: only 64-bit (PE32+) supported, got 0x${optMagic.toString(16)}`);

  const numSect    = buf.readUInt16LE(peOff + PE_NUM_SECTIONS_OFF);
  const optHdrSize = buf.readUInt16LE(peOff + PE_OPT_HDR_SIZE_OFF);
  const sectTable  = peOff + PE_COFF_HDR_SIZE + optHdrSize;

  let match = null;
  for (let i = 0; i < numSect; i++) {
    const entry  = sectTable + i * PE_SECTION_ENTRY_SIZE;
    const rawNm  = buf.subarray(entry, entry + PE_SECT_NAME_LEN);
    const nul    = rawNm.indexOf(0);
    const name   = rawNm.subarray(0, nul === -1 ? rawNm.length : nul).toString('ascii');
    if (name !== BUN_SECTION_NAME) continue;
    if (match) die('PE has multiple .bun sections');
    const rawSize   = buf.readUInt32LE(entry + PE_SECT_RAW_SIZE_OFF);
    const rawOffset = buf.readUInt32LE(entry + PE_SECT_RAW_OFF_OFF);
    if (rawOffset + rawSize > buf.length) die('.bun out of file bounds');
    match = { format: 'PE', os: 'win32', arch, rawOffset, rawSize };
  }
  if (!match) die('PE has no .bun section');
  return match;
}

function findBunSection(buf) {
  if (buf.length < 4) die('file too small');
  const magic = buf.readUInt32LE(0);
  if (magic === ELF_MAGIC_LE)                       return findSectionElf(buf);
  if (magic === MH_MAGIC_64)                        return findSectionMacho(buf);
  if (magic === MH_CIGAM_64 || magic === MH_CIGAM)  die('Mach-O: only little-endian supported');
  if (magic === MH_MAGIC)                           die('Mach-O: only 64-bit supported');
  return findSectionPe(buf);
}

// ─── Payload + module records ────────────────────────────────────────

function parsePayload(sectionData) {
  if (sectionData.length < 8) die('.bun too small for length prefix');
  const payloadSize = readU64LE(sectionData, 0, '.bun payload length');
  if (payloadSize + 8 > sectionData.length) die('.bun payload exceeds raw section');
  const payload = sectionData.subarray(8, 8 + payloadSize);
  if (payload.length < OFFSET_STRUCT_SIZE + TRAILER.length) die('.bun payload too small');
  if (!payload.subarray(payload.length - TRAILER.length).equals(TRAILER)) die('.bun trailer mismatch');
  return payload;
}

function parseOffsets(payload) {
  const start = payload.length - TRAILER.length - OFFSET_STRUCT_SIZE;
  return {
    modules_offset: payload.readUInt32LE(start + 8),
    modules_size:   payload.readUInt32LE(start + 12),
    entry_point_id: payload.readUInt32LE(start + 16),
  };
}

function parseModules(payload, offsets) {
  if (offsets.modules_size % MODULE_RECORD_SIZE !== 0) {
    die(`modules table size not a multiple of ${MODULE_RECORD_SIZE}: ${offsets.modules_size}`);
  }
  const count = offsets.modules_size / MODULE_RECORD_SIZE;
  if (offsets.entry_point_id >= count) die(`entry_point_id ${offsets.entry_point_id} >= ${count}`);
  const table = checkedSlice(payload, offsets.modules_offset, offsets.modules_size, 'modules table');
  const out = [];
  for (let i = 0; i < count; i++) {
    const rec        = table.subarray(i * MODULE_RECORD_SIZE, (i + 1) * MODULE_RECORD_SIZE);
    const nameOff    = rec.readUInt32LE(0);
    const nameSize   = rec.readUInt32LE(4);
    const contentOff = rec.readUInt32LE(8);
    const contentSize= rec.readUInt32LE(12);
    const loaderId   = rec.readUInt8(49);
    const name = decodeName(checkedSlice(payload, nameOff, nameSize, `module[${i}].name`));
    const content = checkedSlice(payload, contentOff, contentSize, `module[${i}].content`);
    out.push({
      index: i,
      entry: i === offsets.entry_point_id,
      name,
      content,
      loader: LOADERS[loaderId] ?? `unknown(${loaderId})`,
    });
  }
  return out;
}

// ─── Output dispatch ─────────────────────────────────────────────────

function napiBasename(name) {
  // Bun records may use either '/' (POSIX builds) or '\\' (PE) as separator;
  // always normalize so basename grabs the right tail.
  const flat = name.replaceAll('\\', '/');
  const tail = flat.split('/').pop() ?? '';
  return tail.replace(/\.node$/i, '');
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  const [,, binaryPath, outputDir] = process.argv;
  if (!binaryPath || !outputDir) {
    console.error('Usage: extract-natives.mjs <binary-path> <output-dir>');
    process.exit(1);
  }
  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    process.exit(1);
  }

  const buf = readFileSync(binaryPath);
  console.log(`Size:    ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const section = findBunSection(buf);
  console.log(`Format:  ${section.format} (${section.arch}-${section.os})`);

  const sectionData = checkedSlice(buf, section.rawOffset, section.rawSize, '.bun section');
  const payload     = parsePayload(sectionData);
  const offsets     = parseOffsets(payload);
  const modules     = parseModules(payload, offsets);
  console.log(`Modules: ${modules.length} (entry id=${offsets.entry_point_id})`);

  mkdirSync(outputDir, { recursive: true });

  const entryMod = modules.find((m) => m.entry);
  const entryText = entryMod ? entryMod.content.toString('utf8') : '';
  // v2.1.245+ splits the app into an ESM chunk graph: the entry is a small
  // ~20KB ESM module static-importing sibling chunk modules + a handful of
  // boot modules, with lazy import() of chunk-*.js. The ~1400 remaining js
  // records and ~170 text/file assets must all be kept on disk as flat
  // siblings, or the entry throws "Cannot find module".
  // Bun mounts the app bundle at "/$bunfs/root" on POSIX builds and at
  // "B:/~BUN/root" on single-drive Windows builds (both are virtual
  // in-bundle roots, differ only by the drive-letter prefix).
  const BUN_MOUNT_RE = /^(?:\/\$bunfs\/root|[A-Za-z]:\/~BUN\/root)\//;
  const bunSub = (name) => {
    const n = name.replaceAll('\\', '/');
    const mm = n.match(BUN_MOUNT_RE);
    return mm ? n.slice(mm[0].length) : null;
  };
  const isChunked = !!entryMod &&
    !entryText.includes('(function(exports, require, module') &&
    (entryText.includes('import{') || BUN_MOUNT_RE.test(entryText));

  // When chunked, also extract every non-napi module to a flat dir so the
  // ESM graph resolves. We flatten <mount>/sub/path → sub__path and keep
  // napi under vendor/. We postpone path rewriting to post-process.mjs
  // (which knows the final install dir).
  const platDir = `${section.arch}-${section.os}`;
  const graphDir = join(outputDir, 'bunfs');

  let cliCount = 0, napiCount = 0, dropped = 0;
  const napiNames = new Set();
  for (const m of modules) {
    if (m.entry) {
      const out = join(outputDir, 'cli.original.js');
      writeFileSync(out, m.content);
      console.log(`  cli.js   ${(m.content.length / 1024 / 1024).toFixed(2)} MB → ${out} (${m.name})`);
      cliCount++;
    } else if (m.loader === 'napi') {
      const base = napiBasename(m.name);
      if (!base) { console.warn(`  skip napi ${m.name}: empty basename`); dropped++; continue; }
      const dir = join(outputDir, 'vendor', base, platDir);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${base}.node`);
      writeFileSync(out, m.content);
      console.log(`  napi     ${(m.content.length / 1024).toFixed(0).padStart(5)} KB → ${out}`);
      napiCount++;
      napiNames.add(m.name.replaceAll('\\', '/'));
    } else if (isChunked && bunSub(m.name)) {
      // js chunk / text asset / file asset: write to flat graph dir so Bun
      // can resolve the rewritten /$bunfs/root/ (POSIX) or B:/~BUN/root/
      // (Windows single-drive) specifiers.
      const sub = bunSub(m.name);
      if (!sub) { dropped++; continue; }
      const flat = sub.replace(/\//g, '__');
      mkdirSync(graphDir, { recursive: true });
      writeFileSync(join(graphDir, flat), m.content);
      console.log(`  chunk    ${(m.content.length / 1024).toFixed(0).padStart(6)} KB → bunfs/${flat}`);
      dropped++;  // count as dropped-from-entry (informational)
    } else {
      dropped++;
    }
  }
  console.log(`Extracted: ${cliCount} cli.js + ${napiCount} napi + ${isChunked ? 'chunk-graph' : 'dropped'} (${dropped} other)`);
  console.log(`  bunfs graph: ${isChunked ? 'yes (' + platDir + ')' : 'no (legacy single-bundle)'}`);
  if (cliCount !== 1) {
    console.error(`error: expected exactly 1 entry-point, got ${cliCount}`);
    process.exit(2);
  }
  if (isChunked) {
    // Write a path-map JSON so post-process.mjs can rewrite every
    // /$bunfs/root/X or B:/~BUN/root/X string literal to the on-disk
    // absolute path.
    const pathMap = {};
    for (const m of modules) {
      const normName = m.name.replaceAll('\\', '/');
      if (!BUN_MOUNT_RE.test(normName)) continue;
      const sub = normName.replace(BUN_MOUNT_RE, '');
      if (!sub) continue;
      if (m.loader === 'napi') {
        const base = napiBasename(m.name);
        pathMap[normName] = `vendor/${base}/${platDir}/${base}.node`;
      } else {
        pathMap[normName] = `bunfs/${sub.replace(/\//g, '__')}`;
      }
    }
    writeFileSync(join(outputDir, 'pathmap.json'), JSON.stringify(pathMap, null, 0) + '\n');
    console.log(`Graph chunks: ${modules.filter((m) => m.loader === 'js').length} js + napi in vendor/`);
  }
}

main();
'@ | Set-Content $extractorPath -Encoding UTF8

# ─── Extract cli.js + native modules from Bun binary ──────────

# Single extractor pass: writes cli.original.js to $ClawDir and creates
# vendor\<name>\<arch>-<os>\<name>.node for every napi module in one go.
$VendorDir = Join-Path $ClawDir "vendor"
if (Test-Path $VendorDir) { Remove-Item -Recurse -Force $VendorDir }

$BunfsDir = Join-Path $ClawDir "bunfs"
if (Test-Path $BunfsDir) { Remove-Item -Recurse -Force $BunfsDir }
$PathMap = Join-Path $ClawDir "pathmap.json"
if (Test-Path $PathMap) { Remove-Item -Force $PathMap }

$dstCli = Join-Path $ClawDir "cli.original.js"
if (Test-Path $dstCli) { Remove-Item -Force $dstCli }

Write-Dim "Extracting cli.js + napi modules from $NativeBinLabel ..."
& node $extractorPath $NativeBin $ClawDir 2>&1 | ForEach-Object { Write-Host "  $_" }
if (-not (Test-Path $dstCli)) {
    Write-Err "Failed to extract cli.js from native binary"
    exit 1
}

# Note: keep extractorPath around — repatch.mjs uses it on version drift

# ─── Post-process cli.js for Bun runtime ──────────────────────

Write-Dim "Rewriting bunfs paths and IIFE invocation ..."
$postProc = Join-Path $ClawDir "post-process.mjs"
@'
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;
const pathMapFile = `${here}/pathmap.json`;

let code = readFileSync(src, 'utf8');

// v2.1.245+ splits the app into an ESM chunk graph; post-process then
// rewrites the whole bunfs/ dir too. Legacy single-bundle has no pathmap.
const isChunked = existsSync(pathMapFile);

// (0) Strip leading @bun pragma comments (e.g. "// @bun @bytecode @bun-cjs\n")
// Bun requires the file to start directly with "(function" (CJS) or the
// first import (ESM) — any preceding comment breaks that detection.
function stripPragma(c) { return c.replace(/^(?:\/\/[^\n]*\n)+/, ''); }

// build-time fileURLToPath() leaks → use cli.cjs's own __filename
function fixFileURLs(c) {
  return c.replace(
    /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
    () => '__filename',
  );
}

if (isChunked) {
  // ── v2.1.245+ ESM chunk graph path ──
  const pathMap = JSON.parse(readFileSync(pathMapFile, 'utf8'));
  // build the replace table: /$bunfs/root/X → <here>/<relative-on-disk>
  const replaceTable = new Map();
  for (const [bunPath, rel] of Object.entries(pathMap)) {
    replaceTable.set(bunPath, join(here, rel));
  }

  function rewriteGraph(text) {
    // Replace string literals containing the virtual in-bundle root
    // (POSIX "/$bunfs/root/..." or Windows single-drive "B:/~BUN/root/...")
    // with the on-disk absolute path from the replace table.
    return text.replace(/["'`](?:\/\$bunfs\/root|[A-Za-z]:\/~BUN\/root)\/[^"'`]+["'`]/g, (m) => {
      const body = m.slice(1, -1);
      const target = replaceTable.get(body) || replaceTable.get(body.replaceAll('\\','/'));
      // JSON.stringify emits a valid JS string literal. This is essential on
      // Windows, where path.join() returns backslashes that would otherwise be
      // interpreted as escapes (for example, \b in "\bunfs").
      return target ? JSON.stringify(target) : m;
    });
  }

  // entry → cli.original.cjs (ESM, no IIFE wrap)
  code = stripPragma(code);
  code = rewriteGraph(code);
  code = fixFileURLs(code);
  writeFileSync(dst, code);
  unlinkSync(src);

  // rewrite every chunk/asset file in bunfs/ in place
  const bunfsDir = join(here, 'bunfs');
  let n = 0;
  for (const f of readdirSync(bunfsDir)) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const fp = join(bunfsDir, f);
    let fc = readFileSync(fp, 'utf8');
    fc = stripPragma(fc);
    fc = rewriteGraph(fc);
    fc = fixFileURLs(fc);
    writeFileSync(fp, fc);
    n++;
  }
  console.log(`cli.original.cjs: ${code.length} bytes (chunked, rewrote ${n} graph files)`);
} else {
  // ── Legacy single-bundle path ──
  code = stripPragma(code);

  // (1) bunfs .node module paths → runtime vendor lookup
  code = code.replace(
    /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
    (m, _full, name) =>
      `require(require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')}))`,
  );

  code = fixFileURLs(code);

  // (3) make the outer (function(...){...}) actually run
  code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

  writeFileSync(dst, code);
  unlinkSync(src);
  console.log(`cli.original.cjs: ${code.length} bytes`);
}
'@ | Set-Content $postProc -Encoding UTF8
& node $postProc 2>&1 | ForEach-Object { Write-Host "  $_" }
if (-not (Test-Path (Join-Path $ClawDir "cli.original.cjs"))) {
    Write-Err "Post-process failed"
    exit 1
}

# Stamp source version so wrapper can detect drift on next launch
Set-Content -Path (Join-Path $ClawDir ".source-version") -Value $NativeBinLabel -Encoding ASCII

# If we pulled the binary from npm into a tmpdir, clean up — extraction
# is done; drift detection only consults %USERPROFILE%\.local\share\claude\versions\.
if ($NativeBinTmpDir -and (Test-Path $NativeBinTmpDir)) {
    Remove-Item -Recurse -Force $NativeBinTmpDir -ErrorAction SilentlyContinue
}

Write-OK "cli.original.cjs ready ($NativeBinLabel)"

}  # end -NoUpgrade skip

# ─── Write re-patch helper (used by wrapper on version drift) ─────────

@'
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

rmSync(join(here, 'vendor'), { recursive: true, force: true });
rmSync(join(here, 'bunfs'), { recursive: true, force: true });
rmSync(join(here, 'pathmap.json'), { force: true });
rmSync(join(here, 'cli.original.js'), { force: true });

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

run('extract', [extractor, nativeBin, here]);
run('post-process', [postProc]);
run('patcher', [patcher]);

writeFileSync(join(here, '.source-version'), basename(nativeBin) + '\n');
console.log(`[clawgod] re-patched to ${basename(nativeBin)}`);
'@ | Set-Content (Join-Path $ClawDir "repatch.mjs") -Encoding UTF8
Write-OK "Re-patch helper installed (repatch.mjs)"

# ─── Write OpenAI-compatible proxy ────────────────────────────

# NOTE: PowerShell here-string @'...'@ cannot contain a line starting with '@
# The proxy source is identical to the install.sh version.
# $PSScriptRoot is empty when run via iex (e.g. claude update → iex(irm $url)).
# Join-Path "" "file" throws a terminating error that -ErrorAction cannot catch.
try { $ProxySource = Get-Content (Join-Path $PSScriptRoot "openai-proxy.cjs") -Raw -ErrorAction Stop } catch { $ProxySource = $null }
if (-not $ProxySource) {
  # Inline fallback: fetch from release assets
  $ProxySource = @'
'use strict';
function translateSystem(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ role: 'system', content: system }];
  if (Array.isArray(system)) {
    var text = system.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    return text ? [{ role: 'system', content: text }] : [];
  }
  return [];
}
function translateMessages(msgs) {
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var msg = msgs[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') { out.push({ role: 'user', content: msg.content }); continue; }
      if (!Array.isArray(msg.content)) continue;
      var toolResults = [], otherBlocks = [];
      for (var j = 0; j < msg.content.length; j++) {
        if (msg.content[j].type === 'tool_result') toolResults.push(msg.content[j]);
        else otherBlocks.push(msg.content[j]);
      }
      for (var k = 0; k < toolResults.length; k++) {
        var tr = toolResults[k], content = '';
        if (typeof tr.content === 'string') content = tr.content;
        else if (Array.isArray(tr.content)) content = tr.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
        if (tr.is_error) content = '[ERROR] ' + content;
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: content || '' });
      }
      if (otherBlocks.length > 0) {
        var parts = [];
        for (var l = 0; l < otherBlocks.length; l++) {
          var block = otherBlocks[l];
          if (block.type === 'text') parts.push({ type: 'text', text: block.text });
          else if (block.type === 'image') {
            var url = block.source.type === 'base64' ? 'data:' + block.source.media_type + ';base64,' + block.source.data : block.source.url;
            parts.push({ type: 'image_url', image_url: { url: url } });
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text });
        else if (parts.length > 0) out.push({ role: 'user', content: parts });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') { out.push({ role: 'assistant', content: msg.content }); continue; }
      if (!Array.isArray(msg.content)) continue;
      var textContent = '', toolCalls = [];
      for (var m = 0; m < msg.content.length; m++) {
        var b = msg.content[m];
        if (b.type === 'text') textContent += b.text;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) } });
      }
      var assistantMsg = { role: 'assistant', content: textContent || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    }
  }
  return out;
}
function translateTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(function (t) {
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } };
  });
}
function stripCacheControl(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  var out = {};
  for (var key in obj) { if (key === 'cache_control') continue; out[key] = stripCacheControl(obj[key]); }
  return out;
}
function translateRequest(body) {
  var cleaned = stripCacheControl(body);
  var systemMsgs = translateSystem(cleaned.system);
  var userMsgs = translateMessages(cleaned.messages || []);
  var openaiBody = { model: cleaned.model, messages: systemMsgs.concat(userMsgs), stream: !!cleaned.stream };
  if (cleaned.max_tokens) openaiBody.max_tokens = cleaned.max_tokens;
  if (cleaned.temperature !== undefined) openaiBody.temperature = cleaned.temperature;
  if (cleaned.top_p !== undefined) openaiBody.top_p = cleaned.top_p;
  if (cleaned.stop_sequences) openaiBody.stop = cleaned.stop_sequences;
  var tools = translateTools(cleaned.tools);
  if (tools) openaiBody.tools = tools;
  if (cleaned.stream) openaiBody.stream_options = { include_usage: true };
  return openaiBody;
}
function mapFinishReason(reason) {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}
function translateResponse(openaiResp, requestModel) {
  var choice = openaiResp.choices && openaiResp.choices[0];
  if (!choice) return { id: 'msg_proxy_error', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'No response from upstream API' }], model: requestModel, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  var content = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
  if (choice.message.tool_calls) {
    for (var i = 0; i < choice.message.tool_calls.length; i++) {
      var tc = choice.message.tool_calls[i], input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: input });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return { id: openaiResp.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', content: content, model: requestModel || openaiResp.model, stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null, usage: { input_tokens: (openaiResp.usage && openaiResp.usage.prompt_tokens) || 0, output_tokens: (openaiResp.usage && openaiResp.usage.completion_tokens) || 0 } };
}
function sse(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
function createStreamTranslator(requestModel) {
  var state = { model: requestModel, blockIndex: 0, sentStart: false, inText: false, tcBufs: {}, inTok: 0, outTok: 0, msgId: 'msg_' + Date.now() };
  return function (chunk) {
    var events = [];
    if (!state.sentStart) {
      state.sentStart = true;
      if (chunk.id) state.msgId = chunk.id;
      events.push(sse('message_start', { type: 'message_start', message: { id: state.msgId, type: 'message', role: 'assistant', content: [], model: state.model || chunk.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
      events.push(sse('ping', { type: 'ping' }));
    }
    var choice = chunk.choices && chunk.choices[0];
    if (!choice) { if (chunk.usage) { state.inTok = chunk.usage.prompt_tokens || 0; state.outTok = chunk.usage.completion_tokens || 0; } return events; }
    var delta = choice.delta || {};
    if (delta.content) {
      if (!state.inText) { state.inText = true; events.push(sse('content_block_start', { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } })); }
      events.push(sse('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: delta.content } }));
    }
    if (delta.tool_calls) {
      if (state.inText) { events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex })); state.blockIndex++; state.inText = false; }
      for (var i = 0; i < delta.tool_calls.length; i++) {
        var tc = delta.tool_calls[i], idx = tc.index;
        if (!state.tcBufs[idx]) {
          var tcId = tc.id || ('toolu_' + Date.now() + '_' + idx), tcName = (tc.function && tc.function.name) || '';
          state.tcBufs[idx] = { id: tcId, name: tcName, bi: state.blockIndex };
          events.push(sse('content_block_start', { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'tool_use', id: tcId, name: tcName, input: {} } }));
          state.blockIndex++;
        }
        var buf = state.tcBufs[idx];
        if (tc.function && tc.function.name) buf.name = tc.function.name;
        if (tc.function && tc.function.arguments) {
          events.push(sse('content_block_delta', { type: 'content_block_delta', index: buf.bi, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
        }
      }
    }
    if (choice.finish_reason) {
      if (state.inText) { events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex })); state.inText = false; }
      for (var key in state.tcBufs) events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.tcBufs[key].bi }));
      events.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null }, usage: { output_tokens: state.outTok } }));
      events.push(sse('message_stop', { type: 'message_stop' }));
    }
    return events;
  };
}
function parseSSELines(text) {
  var chunks = [], lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line.startsWith('data: ')) continue;
    var payload = line.substring(6);
    if (payload === '[DONE]') { chunks.push(null); continue; }
    try { chunks.push(JSON.parse(payload)); } catch (e) {}
  }
  return chunks;
}
function startProxy(config) {
  var upstreamURL = (config.baseURL || 'https://api.x.ai/v1').replace(/\/+$/, '');
  var upstreamKey = config.apiKey;
  var server = Bun.serve({
    port: 0, hostname: '127.0.0.1', idleTimeout: 255,
    fetch: async function (req) {
      var url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') return new Response('ok');
      if (req.method !== 'POST' || !url.pathname.endsWith('/messages'))
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      var body;
      try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      var requestModel = body.model || config.model || '';
      var isStream = !!body.stream;
      var openaiBody;
      try { openaiBody = translateRequest(body); } catch (e) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Translation error: ' + e.message } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      var upstreamResp;
      try {
        upstreamResp = await fetch(upstreamURL + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + upstreamKey },
          body: JSON.stringify(openaiBody),
        });
      } catch (e) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream connection failed: ' + e.message } }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
      if (!upstreamResp.ok && !isStream) {
        var errText = await upstreamResp.text().catch(function () { return ''; });
        var errBody; try { errBody = JSON.parse(errText); } catch (e) { errBody = null; }
        return new Response(JSON.stringify({ type: 'error', error: { type: upstreamResp.status === 429 ? 'rate_limit_error' : 'api_error', message: (errBody && errBody.error && errBody.error.message) || errText || ('HTTP ' + upstreamResp.status) } }), { status: upstreamResp.status, headers: { 'Content-Type': 'application/json' } });
      }
      if (!isStream) {
        var result; try { result = await upstreamResp.json(); } catch (e) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Invalid upstream response' } }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(translateResponse(result, requestModel)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      var translator = createStreamTranslator(requestModel);
      var upstreamBody = upstreamResp.body;
      var readable = new ReadableStream({
        async start(controller) {
          var encoder = new TextEncoder(), decoder = new TextDecoder(), buffer = '';
          try {
            var reader = upstreamBody.getReader();
            while (true) {
              var r = await reader.read();
              if (r.done) break;
              buffer += decoder.decode(r.value, { stream: true });
              var boundary = buffer.lastIndexOf('\n');
              if (boundary === -1) continue;
              var complete = buffer.substring(0, boundary + 1);
              buffer = buffer.substring(boundary + 1);
              var chunks = parseSSELines(complete);
              for (var ci = 0; ci < chunks.length; ci++) {
                if (chunks[ci] === null) continue;
                var evts = translator(chunks[ci]);
                for (var ei = 0; ei < evts.length; ei++) controller.enqueue(encoder.encode(evts[ei]));
              }
            }
            if (buffer.trim()) {
              var rem = parseSSELines(buffer);
              for (var ri = 0; ri < rem.length; ri++) {
                if (rem[ri] === null) continue;
                var revts = translator(rem[ri]);
                for (var rei = 0; rei < revts.length; rei++) controller.enqueue(encoder.encode(revts[rei]));
              }
            }
          } catch (e) { controller.enqueue(encoder.encode(sse('error', { type: 'error', error: { type: 'api_error', message: 'Stream error: ' + e.message } }))); }
          finally { controller.close(); }
        },
      });
      return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
    },
  });
  return { port: server.port, stop: function () { server.stop(); } };
}
module.exports = { startProxy: startProxy };
'@
}
$ProxySource | Set-Content (Join-Path $ClawDir "openai-proxy.cjs") -Encoding UTF8
Write-OK "OpenAI-compatible proxy created (openai-proxy.cjs)"

# ─── Write wrapper (cli.cjs, runs under Bun) ──────────────────

@'
#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } = require('fs');
const { join, basename } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const clawgodDir = join(homedir(), '.clawgod');

// Note: drift detection removed — see install.sh wrapper for full notes.
// `versions/` either doesn't exist (Windows) or doesn't grow on healthy
// clawgod installs (we patch out `claude update`), so the check could only
// retract a fresh install.ps1 / install.sh upgrade. `claude update` →
// install.sh redirect is the single source of truth for version upgrades.

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

// OpenAI-compatible provider proxy (grok, openai-compat, etc.)
const _proxyTypes = { grok: 1, 'openai-compat': 1 };
if (_proxyTypes[config.type]) {
  let _proxyKey = config.apiKey || '';
  if (!_proxyKey && config.type === 'grok') {
    try {
      const _gs = JSON.parse(readFileSync(join(homedir(), '.grok', 'user-settings.json'), 'utf8'));
      _proxyKey = _gs.apiKey || '';
    } catch {}
    if (!_proxyKey) _proxyKey = process.env.GROK_API_KEY || '';
  }
  if (_proxyKey) {
    const { startProxy } = require('./openai-proxy.cjs');
    const _proxy = startProxy({
      apiKey: _proxyKey,
      baseURL: config.baseURL || (config.type === 'grok' ? 'https://api.x.ai/v1' : ''),
      model: config.model || '',
    });
    process.env.ANTHROPIC_API_KEY = 'proxy-passthrough';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + _proxy.port;
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-passthrough';
    if (config.model) process.env.ANTHROPIC_MODEL = config.model;
    if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1';
    process.on('exit', function () { try { _proxy.stop(); } catch {} });
    process.stderr.write('[clawgod] OpenAI-compat proxy on port ' + _proxy.port + ' (type: ' + config.type + ')\n');
    config = { ...defaultConfig };
  } else {
    process.stderr.write('[clawgod] Warning: type=' + config.type + ' but no API key found\n');
  }
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

// Third-party Anthropic-compatible proxies (DeepSeek / OneAPI / Bedrock /
// vLLM / etc.) don't share Anthropic's server-side handling of
// x-anthropic-billing-header. That header carries a per-request `cch` field
// which Anthropic's own server excludes from prompt-cache key calculation
// (via cacheScope:null), but third-party proxies fold into the prefix hash —
// so the cached prefix changes every request and cache hit rate drops to
// zero. Auto-disable the header whenever baseURL points away from Anthropic.
// Users can force re-enable with CLAUDE_CODE_ATTRIBUTION_HEADER=1 if needed.
if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER ??= '0';
  try {
    const _rcSettings = join(homedir(), '.claude', 'settings.json');
    if (existsSync(_rcSettings)) {
      const _rcS = JSON.parse(readFileSync(_rcSettings, 'utf8'));
      if (_rcS.disableRemoteControl) {
        delete _rcS.disableRemoteControl;
        writeFileSync(_rcSettings, JSON.stringify(_rcS, null, 2) + '\n');
      }
    }
  } catch {}
}

if (config.timeoutMs) {
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
}
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
process.env.USE_BUILTIN_RIPGREP ??= '1';

const featuresFile = join(providerDir, 'features.json');
if (!process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

// Monkey-patch process.execPath: Anthropic's CLI uses process.execPath to
// locate the native binary for shell wrappers (find→bfs, grep→ugrep, rg) and
// subprocess spawning. Under Bun, process.execPath returns the Bun runtime
// path, not the Claude native binary. The launcher script sets
// CLAUDE_CODE_EXECPATH to claude.orig (the real binary) before exec'ing
// Bun, so we use that as the source of truth.  See issue #100.
const _realExecPath = process.env.CLAUDE_CODE_EXECPATH || process.execPath;
if (_realExecPath !== process.execPath) {
  Object.defineProperty(process, 'execPath', {
    value: _realExecPath,
    configurable: true,
  });
}

// Lean mode toggle — --lean-off / --lean-on / --lean-max
if (process.argv.includes('--lean-off') || process.argv.includes('--lean-on') || process.argv.includes('--lean-max')) {
  const _leanOff = join(clawgodDir, '.lean-disabled');
  const _leanMax = join(clawgodDir, '.lean-max');
  const _leanSettings = join(homedir(), '.claude', 'settings.json');
  const _baseDeny = ['DesignSync','NotebookEdit','PushNotification','RemoteTrigger','CronCreate','CronDelete','CronList'];
  const _maxDeny = ['EnterPlanMode','ExitPlanMode','SendMessage','ScheduleWakeup','AskUserQuestion','ReportFindings'];
  const _baseFlags = ['disableWorkflows','disableRemoteControl','disableClaudeAiConnectors','disableArtifact'];
  const _maxFlags = ['disableBundledSkills'];
  const _allDeny = new Set([..._baseDeny, ..._maxDeny]);
  const _allFlags = [..._baseFlags, ..._maxFlags];
  const _unlink = function(p) { try { require('fs').unlinkSync(p); } catch {} };
  if (process.argv.includes('--lean-off')) {
    writeFileSync(_leanOff, '');
    _unlink(_leanMax);
    try {
      const _s = JSON.parse(readFileSync(_leanSettings, 'utf8'));
      for (const _k of _allFlags) delete _s[_k];
      if (Array.isArray(_s.permissions?.deny)) _s.permissions.deny = _s.permissions.deny.filter(function(t) { return !_allDeny.has(t); });
      writeFileSync(_leanSettings, JSON.stringify(_s, null, 2) + '\n');
    } catch {}
    process.stderr.write('[clawgod] Lean mode disabled. All tools restored.\n');
  } else {
    const _isMax = process.argv.includes('--lean-max');
    _unlink(_leanOff);
    if (_isMax) writeFileSync(_leanMax, ''); else _unlink(_leanMax);
    const _deny = _isMax ? [..._baseDeny, ..._maxDeny] : _baseDeny;
    const _flags = _isMax ? _allFlags : _baseFlags;
    try {
      let _s = {};
      try { _s = JSON.parse(readFileSync(_leanSettings, 'utf8')); } catch {}
      let _ch = false;
      for (const _k of _flags) { if (!(_k in _s)) { _s[_k] = true; _ch = true; } }
      if (!_isMax) { for (const _k of _maxFlags) { if (_k in _s) { delete _s[_k]; _ch = true; } } }
      if (!_s.permissions) _s.permissions = {};
      if (!Array.isArray(_s.permissions.deny)) _s.permissions.deny = [];
      const _ex = new Set(_s.permissions.deny);
      for (const _t of _deny) { if (!_ex.has(_t)) { _s.permissions.deny.push(_t); _ch = true; } }
      if (!_isMax) {
        const _maxSet = new Set(_maxDeny);
        const _before = _s.permissions.deny.length;
        _s.permissions.deny = _s.permissions.deny.filter(function(t) { return !_maxSet.has(t); });
        if (_s.permissions.deny.length !== _before) _ch = true;
      }
      if (_ch) writeFileSync(_leanSettings, JSON.stringify(_s, null, 2) + '\n');
    } catch {}
    process.stderr.write('[clawgod] Lean mode: ' + (_isMax ? 'max' : 'on') + '. Settings updated.\n');
  }
  process.exit(0);
}

// Update check — cached, non-blocking, 24h interval
try {
  const _ucFile = join(clawgodDir, '.update-check');
  const _verFile = join(clawgodDir, '.clawgod-version');
  if (existsSync(_verFile)) {
    const _localVer = readFileSync(_verFile, 'utf8').trim();
    let _uc = null;
    try { if (existsSync(_ucFile)) _uc = JSON.parse(readFileSync(_ucFile, 'utf8')); } catch {}
    var _semGt = function(a, b) { var x = a.split('.'), y = b.split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i]||0)) - (parseInt(y[i]||0)); if (d) return d > 0; } return false; };
    if (_uc && _uc.v && _semGt(_uc.v, _localVer)) {
      process.stderr.write('[clawgod] v' + _uc.v + ' available (installed: v' + _localVer + ") — run 'claude update' to upgrade\n");
    }
    if (!_uc || Date.now() - (_uc.t || 0) > 86400000) {
      fetch('https://api.github.com/repos/0Chencc/clawgod/releases/latest', {
        headers: { 'User-Agent': 'clawgod' },
        signal: AbortSignal.timeout(5000),
      }).then(function(r) { return r.json(); }).then(function(d) {
        var v = (d.tag_name || '').replace(/^v/, '');
        if (v) writeFileSync(_ucFile, JSON.stringify({ t: Date.now(), v: v }));
      }).catch(function() {});
    }
  }
} catch {}

require('./cli.original.cjs');
'@ | Set-Content (Join-Path $ClawDir "cli.cjs") -Encoding UTF8
Set-Content (Join-Path $ClawDir ".clawgod-version") $ClawSelfVersion
Write-OK "Wrapper created (cli.cjs)"

# ─── Write universal patcher ──────────────────────────
# (Same Node.js patcher as bash version — inline to avoid extra download)

$patcherCode = @'
#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
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
    // Bun.isStandaloneExecutable is false under clawgod (plain Bun runtime,
    // not a compiled standalone binary). fv() guards daemon/fork spawn logic
    // (DLt), multitool dispatch (RS), and several other codepaths that need
    // to behave as if running the native binary. The property is frozen on
    // Bun 1.4+ (configurable:false, writable:false), so runtime monkey-patch
    // is impossible — patch the source instead. See issue #133.
    //
    // v2.1.236+ wraps the guard in a typeof-Bun check:
    //   function fv(){return Bun.isStandaloneExecutable===!0}        ≤v2.1.235
    //   function kw(){return typeof Bun<"u"&&Bun.isStandaloneExecutable===!0}  v2.1.236+
    // Match both via an optional `typeof Bun<"u"&&` prefix.
    name: 'Bun.isStandaloneExecutable → true',
    pattern: /function ([\w$]+)\(\)\{return (?:typeof Bun<"u"&&)?Bun\.isStandaloneExecutable===!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'GrowthBook env overrides',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\)=!0;return ([\w$]+)\}/g,
    replacer: (m, fn, flag, val) =>
      `function ${fn}(){if(!${flag}){${flag}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    unique: true,  // must match exactly 1
  },
  {
    // v2.1.245+ moved env-override parsing into a GrowthBook class method and
    // introduced a dead-code bug: the lazy parse short-circuits on the second
    // return, so features.json (CLAUDE_INTERNAL_FC_OVERRIDES) never reaches the
    // feature store — tengu_prompt_cache_1h_config & friends silently lose effect.
    //
    // v2.1.246 shape (chunk graph, _668.js):
    //   getEnvironmentOverrides(){if(this.environmentOverridesParsed)return this.environmentOverrides;return this.environmentOverridesParsed=!0,this.environmentOverrides;let e=this.deps.readEnvironmentOverrides();if(!e)return this.environmentOverrides;try{this.environmentOverrides=Ce(e),p(`GrowthBook: Using env var overrides for ${...}`)}catch{p(`GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${e}`,...)}return this.environmentOverrides}
    // Patch removes the short-circuit second return so the body reaches the
    // env-var read. Cross-version: match the lazy-parse idiom (flag=!0,value).
    name: 'GrowthBook env overrides (graph dead-code fix)',
    pattern: /return this\.environmentOverridesParsed=!0,this\.environmentOverrides;(?=let e=this\.deps\.readEnvironmentOverrides\(\);)/g,
    replacer: () => '',
    sentinel: 'environmentOverridesParsed=!0,this.environmentOverrides',
    optional: true,
  },
  {
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){return null}${next}`,
    selectIndex: 0,
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
  },
  {
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    // v2.1.245+ Agent Teams gate became an exported module in its own chunk
    // with differently-minified identifiers. Shape (v2.1.246,_445.js):
    //   function i(){return process.argv.includes("--agent-teams")}
    //   function s(){if(!e.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&!i())return!1;if(!t("tengu_amber_flint",!0))return!1;return!0}
    // Match the flag-gate by the tengu_amber_flint + return!1 shape, tolerant
    // of the identifier set and the argv helper.
    name: 'Agent Teams always enabled (graph)',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,
  },
  {
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // The middle metadata block changed from a literal description to a getter,
    // and the gate switched from a literal !1 to a GrowthBook-flag-check function call.
    // Match both.
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
    sentinel: 'name:"ultraplan"',
  },
  {
    // ≤v2.1.110: function X(){return Y("tengu_review_bughunter_config",null)?.enabled===!0}
    // v2.1.119+: function X(){return Y("tengu_review_bughunter_config",null)} — bare getter
    // v2.1.152+: same bare-getter shape, config also feeds cost_note/duration_note/model
    // v2.1.214+: config key moved to a variable:
    //   var Yau="tengu_review_bughunter_config";
    //   function Fot(){return et(Yau,null)}
    //   function rQt(){return Fot()?.enabled===!0&&ru()&&!J6()}
    //   Patch rQt to always return true so ultrareview is unlocked.
    //   Also match the old direct-literal form for <=2.1.213 compat.
    name: 'Ultrareview enable (rQt gate)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\(\)\?\.enabled===!0&&[\w$]+\(\)&&![\w$]+\(\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,
  },
  {
    name: 'Ultrareview enable (direct literal, <=2.1.213)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn, getter, gate) =>
      gate
        ? `function ${fn}(){return!0}`
        : `function ${fn}(){let _r=${getter}("tengu_review_bughunter_config",null);return _r?{..._r,enabled:!0}:{enabled:!0}}`,
    optional: true,
  },
  {
    name: 'Computer Use gate bypass',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\(\)&&[\w$]+\(\)\.enabled\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    // v2.1.158+: provider gate refactored into helper function:
    //   function mw$(H){if(H==="firstParty"||H==="anthropicAws")return!0;return CH(process.env.CLAUDE_CODE_ENABLE_AUTO_MODE)}
    //   Called as: if(!mw$(q))return!1;  inside the auto-mode model gate.
    //   Lookahead ensures we only strip the call inside the auto-mode gate
    //   (the next 300 chars must contain !=="firstParty") and not unrelated
    //   if(!fn(x))return!1; patterns elsewhere.
    //   Not present in ≤v2.1.149 (provider gate was inline).
    name: 'Auto-mode unlock for third-party API (provider helper gate)',
    pattern: /if\(!([\w$]+)\(([\w$]+)\)\)return!1;(?=(?:(?!function\s).){0,300}!=="firstParty")/g,
    replacer: () => '',
    optional: true,
  },
  {
    // ≤v2.1.149: if(Y!=="firstParty"&&Y!=="anthropicAws")return!1;
    // v2.1.158+: if(q!=="firstParty"&&q!=="anthropicAws"&&($==="claude-opus-4-6"||…))return!1;
    // v2.1.214+: if(r!=="firstParty"&&!d6(r)&&(t==="claude-opus-4-6"||…))return!1;
    //   "anthropicAws" replaced by helper function !fn(var).
    //   Match both: \1!=="anthropicAws" OR !fn(\1).
    name: 'Auto-mode unlock for third-party API (inline gate)',
    pattern: /if\(([\w$]+)!=="firstParty"&&(?:\1!=="anthropicAws"|![\w$]+\(\1\))[^;]*\)return!1;/g,
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
    //
    // v2.1.232+ wraps the action handler in a framework helper. The helper
    // is a minified identifier whose name drifts across builds:
    //   .action(async()=>{…})              ≤v2.1.231
    //   .action(t(async(a)=>{…}))          v2.1.232 … v2.1.237
    //   .action(n(async(u)=>{…}))          v2.1.238+
    // Match any one-letter minified helper via `identifier(` rather than
    // hardcoding a name, so a future rename keeps matching.
    name: "Redirect `claude update` to clawgod self-update",
    pattern: /(\.command\("update"\)\.alias\("upgrade"\)\.description\("[^"]+"\))(\.action\((?:[A-Za-z_$][\w$]*\()?async\([^)]*\)=>\{)/g,
    replacer: (m, chain, action) => {
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
        "$u='https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1';" +
        "if($p){iex(irm -Proxy $p $u)}else{iex(irm $u)}";
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      return (
        chain + '.allowUnknownOption()' + action +
        `const _ui=process.argv.findIndex(a=>a==="update"||a==="upgrade");` +
        `const _ua=_ui>=0?process.argv.slice(_ui+1):[];` +
        `const _vi=_ua.indexOf("--version");` +
        `if(_vi>=0&&_ua[_vi+1])process.env.CLAWGOD_VERSION=_ua[_vi+1];` +
        `if(_ua.includes("--no-upgrade"))process.env.CLAWGOD_NO_UPGRADE="1";` +
        `if(_ua.includes("--lean-off"))process.env.CLAWGOD_LEAN_OFF="1";` +
        `if(_ua.includes("--lean-on"))process.env.CLAWGOD_LEAN_ON="1";` +
        `if(_ua.includes("--lean-max"))process.env.CLAWGOD_LEAN_MAX="1";` +
        `process.stderr.write("[clawgod] 'claude update' is handled by clawgod self-update.\\n[clawgod] To leave clawgod and use vanilla update: bash ~/.clawgod/install.sh --uninstall\\n[clawgod] Continuing now\\u2026\\n");` +
        `const _w=process.platform==='win32';` +
        `const _c=_w?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash'];` +
        `const _r=require('child_process').spawnSync(_c[0],_c.slice(1),{stdio:'inherit',env:process.env});` +
        `process.exit(_r.status||0);`
      );
    },
    sentinel: '.command("update").alias("upgrade")',
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
  {
    name: 'Theme claude color → green (ANSI)',
    pattern: /claude:"ansi:redBright"/g,
    replacer: () => 'claude:"ansi:greenBright"',
  },
  {
    name: 'Shimmer → green (ANSI)',
    pattern: /claudeShimmer:"ansi:yellowBright"/g,
    replacer: () => 'claudeShimmer:"ansi:greenBright"',
  },
  {
    name: 'Brief label claude color → green (RGB dark)',
    pattern: /briefLabelClaude:"rgb\(215,119,87\)"/g,
    replacer: () => 'briefLabelClaude:"rgb(34,197,94)"',
  },
  {
    name: 'Brief label claude color → green (RGB light)',
    pattern: /briefLabelClaude:"rgb\(255,153,51\)"/g,
    replacer: () => 'briefLabelClaude:"rgb(22,163,74)"',
  },
  {
    name: 'Brief label claude color → green (ANSI)',
    pattern: /briefLabelClaude:"ansi:redBright"/g,
    replacer: () => 'briefLabelClaude:"ansi:greenBright"',
  },

  // ── macOS Cmd+V 图片粘贴修复 ──

  {
    // Under Bun runtime (clawgod), macOS Cmd+V pastes the image file path
    // as text instead of triggering the clipboard image read. The paste
    // handler detects the path as an image file (gCc), tries to read it
    // via yCc, fails, and falls through to display the raw path as text.
    //
    // Fix: when all image path reads fail (L.length===0 && R.length>0)
    // and we're on macOS (d) with no other text (D.length===0), fall back
    // to the clipboard image reader (m()) — same path that Ctrl+V uses.
    //
    // Shape:
    //   if(L.length===0&&R.length>0)at("input_image_drag","read_failed"),D.push(...R)
    //
    // Patched:
    //   if(L.length===0&&R.length>0){at("input_image_drag","read_failed");if(d&&D.length===0){m();return}D.push(...R)}
    name: 'macOS Cmd+V image paste fallback to clipboard read',
    pattern: /if\(([\w$]+)\.length===0&&([\w$]+)\.length>0\)([\w$]+)\("input_image_drag","read_failed"\),([\w$]+)\.push\(\.\.\.\2\)/g,
    replacer: (m, L, R, at, D) =>
      `if(${L}.length===0&&${R}.length>0){${at}("input_image_drag","read_failed");if(d&&${D}.length===0){m();return}${D}.push(...${R})}`,
    sentinel: '"input_image_drag","read_failed"',
    optional: true,
  },

  // ── Glob/Grep 工具恢复 ──

  {
    // Bun inlines EMBEDDED_SEARCH_TOOLS env as literal "true" at compile time.
    // This makes bC() always return true → Wft() returns the shadow set
    // containing "Glob" and "Grep" → those tools are hidden from the user.
    // Under clawgod (Bun runtime, not native binary) the env is unset, but
    // the code still says ct("true") instead of ct(process.env.EMBEDDED_SEARCH_TOOLS).
    //
    // Shape:
    //   function bC(){if(!ct("true"))return!1;if(mEr())return!1;
    //     return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}
    //
    // Patch: replace ct("true") with ct(process.env.EMBEDDED_SEARCH_TOOLS)
    // so the guard reads the actual env var (unset → falsy → return false →
    // Glob/Grep tools available).
    name: 'Restore Glob/Grep tools (un-inline EMBEDDED_SEARCH_TOOLS)',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\("true"\)\)return!1;if\([\w$]+\(\)\)return!1;return process\.env\.CLAUDE_CODE_ENTRYPOINT!=="local-agent"\}/g,
    replacer: (m, fn, envCheck) =>
      `function ${fn}(){if(!${envCheck}(process.env.EMBEDDED_SEARCH_TOOLS))return!1;if(typeof globalThis.__dpBinOk>"u"){try{var _w=process.platform==="win32"?"where":"which";require("child_process").execFileSync(_w,["bfs"],{timeout:2e3});require("child_process").execFileSync(_w,["ugrep"],{timeout:2e3});globalThis.__dpBinOk=!0}catch{globalThis.__dpBinOk=!1}}if(!globalThis.__dpBinOk)return!1;return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}`,
    sentinel: 'ct("true")',
    optional: true,
  },

  // ── 地区隐写中和 (v2.1.197+) ──

  {
    // v2.1.197+: geo-steganography in system prompt date string.
    // qla(e) builds "Today{apostrophe}s date is {date}." where:
    //   - the apostrophe encodes proxy-detection state (U+0027/U+2019/U+02BC/U+02B9)
    //   - the date separator encodes timezone (- for non-CN, / for CN)
    //
    // Shape:
    //   function qla(e){let t=rdp(),n=odp(t?.known??!1,t?.labKw??!1),
    //     r=t?.cnTZ?e.replaceAll("-","/"):e;return`Today${n}s date is ${r}.`}
    //
    // Patch: replace entire function body to always use ASCII apostrophe
    // and pass through the date string unmodified.
    name: 'Neutralize geo-steganography in date string (qla)',
    pattern: /function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\([\w$]+\?\.[\w$]+\?\?!1,[\w$]+\?\.[\w$]+\?\?!1\),[\w$]+=[\w$]+\?\.[\w$]+\?[\w$]+\.replaceAll\("-","\/"\):[\w$]+;return`Today\$\{[\w$]+\}s date is \$\{[\w$]+\}\.`\}/g,
    replacer: (m) => {
      // Extract function name and parameter name from the match
      const fnMatch = m.match(/^function ([\w$]+)\(([\w$]+)\)/);
      if (!fnMatch) return m;
      const [, fn, param] = fnMatch;
      return `function ${fn}(${param}){return\`Today's date is \${${param}}.\`}`;
    },
    sentinel: 'replaceAll("-","/")',
  },
  {
    // v2.1.197+: rdp() performs three-axis geo detection:
    //   1. timezone === "Asia/Shanghai" || "Asia/Urumqi"  → cnTZ
    //   2. ANTHROPIC_BASE_URL hostname in XOR-obfuscated domain blocklist → known
    //   3. ANTHROPIC_BASE_URL contains CN-LLM vendor keywords → labKw
    //
    // Shape:
    //   function rdp(){if(vrt())return null;let e=ndp(),t=ekt(),
    //     n=t==="Asia/Shanghai"||t==="Asia/Urumqi";if(!e)return{known:!1,labKw:!1,cnTZ:n,host:null};
    //     return{known:edp().some(...),labKw:tdp().some(...),cnTZ:n,host:e}}
    //
    // Patch: always return null (same as firstParty path), disabling all detection.
    name: 'Neutralize geo-detection probe (rdp)',
    pattern: /function ([\w$]+)\(\)\{if\([\w$]+\(\)\)return null;let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\(\),[\w$]+=[\w$]+==="Asia\/Shanghai"\|\|[\w$]+==="Asia\/Urumqi"[\s\S]*?\}\}/g,
    replacer: (m) => {
      const fn = m.match(/^function ([\w$]+)/)[1];
      return `function ${fn}(){return null}`;
    },
    sentinel: 'Asia/Shanghai',
  },
  {
    // v2.1.197+: odp(known, labKw) selects a Unicode apostrophe to encode
    // proxy detection state into the system prompt:
    //   !known && !labKw → U+0027 (ASCII)
    //   known  && !labKw → U+2019 (RIGHT SINGLE QUOTATION MARK)
    //   !known && labKw  → U+02BC (MODIFIER LETTER APOSTROPHE)
    //   known  && labKw  → U+02B9 (MODIFIER LETTER PRIME)
    //
    // Shape:
    //   function odp(e,t){if(!e&&!t)return"'";if(e&&!t)return"'";
    //     if(!e&&t)return"ʼ";return"ʹ"}
    //
    // Patch: always return ASCII apostrophe regardless of detection state.
    // The return values may appear as \uXXXX escapes or literal UTF-8 in
    // the bundle depending on bundler version. Match both forms.
    // Defense-in-depth — qla patch above already bypasses the call to odp,
    // but if qla's shape changes this keeps odp harmless.
    name: 'Neutralize apostrophe steganography (odp)',
    pattern: new RegExp(
      'function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{' +
      'if\\(!\\2&&!\\3\\)return"\'";' +
      'if\\(\\2&&!\\3\\)return"(?:\\\\u2019|\\u2019)";' +
      'if\\(!\\2&&\\3\\)return"(?:\\\\u02[Bb][Cc]|\\u02BC)";' +
      'return"(?:\\\\u02[Bb]9|\\u02B9)"\\}',
      'g'
    ),
    replacer: (m) => {
      const fn = m.match(/^function ([\w$]+)/)[1];
      return `function ${fn}(e,t){return"'"}`;
    },
    optional: true,  // defense-in-depth; rdp→null already neutralizes the stego channel
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
  {
    // Shell-integration generator (iT6 in v2.1.140, was Wa1 in older versions)
    // emits a zsh/bash function that calls the native claude binary with
    // ARGV0=ugrep|rg|... for multitool dispatch. After clawgod installs, the
    // baked path points at our shell-script launcher — but shell scripts
    // CANNOT preserve argv[0] (kernel shebang re-exec overwrites it, and zsh
    // additionally refuses to export ARGV0 as env). The shell function then
    // fails because bun receives e.g. -G and errors with "Invalid Argument".
    //
    // Fix: redirect the baked path to claude.orig (the native binary backup
    // clawgod creates at install time). Then the multitool dispatch reaches
    // a real binary that honors argv[0]. See issue #82.
    //
    // Generator shape across versions:
    //   v2.1.88 (Wa1):  let Y=E4([_]),...  ← _ is the claude binary path, no in-function compute
    //   v2.1.140 (iT6): let ...,z=FJ$.join(Le(),A?"claude.exe":"claude"),Y=A?rL(z):z,...
    //                   ← path computed inside via join(versionsDir, "claude[.exe]")
    // Anchor on the join(...) ternary form unique to the generator — the
    // bare "claude.exe":"claude" string also appears in u18() (basename
    // helper) but never inside a path.join(), so this regex hits exactly the
    // shell-integration generator and nothing else.
    name: 'Shell integration → claude.orig (multitool dispatch fix)',
    pattern: /([\w$]+\.join\([\w$]+\(\),[\w$]+\?)"claude\.exe":"claude"(\))/g,
    replacer: (m, prefix, suffix) => `${prefix}"claude.orig.exe":"claude.orig"${suffix}`,
    sentinel: '?"claude.exe":"claude")',
    optional: true,  // v2.1.88-era bundles compute the path differently
  },
];

// ─── Main ─────────────────────────────────────────────────

// cli.original path (legacy single-bundle) or graph dir (v2.1.245+)
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');

const GRAPH_DIR = join(__dirname, 'bunfs');
const isGraph = existsSync(GRAPH_DIR);

if (revert) {
  if (isGraph) {
    // graph: restore each file from its .bak (no-op if none) — full graph
    // backup isn't taken for chunks; only the entry has a .bak. Re-extract
    // instead: the safest revert for graph installs is to rerun extract.
    console.log('⚠️  Graph install detected — run install.sh to re-extract clean source.');
    process.exit(0);
  }
  if (!existsSync(BACKUP)) { console.error('❌ No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('✅ Reverted from backup');
  process.exit(0);
}

// ── Load target(s) ─────────────────────────────
// isGraph: files = { 'cli.original.cjs': '...', 'bunfs/_444.js': '...', ... }
// else:    files = { 'cli.original.cjs': '...' }
let files = {};
if (isGraph) {
  files[TARGET] = readFileSync(TARGET, 'utf8');
  for (const f of readdirSync(GRAPH_DIR)) {
    if (!/\.js$/.test(f) && !/\.mjs$/.test(f)) continue;
    files[join(GRAPH_DIR, f)] = readFileSync(join(GRAPH_DIR, f), 'utf8');
  }
} else {
  if (!existsSync(TARGET)) {
    console.error('❌ Target not found:', TARGET);
    process.exit(1);
  }
  files[TARGET] = readFileSync(TARGET, 'utf8');
}

// Extract version from entry content
const version = (files[TARGET] || '').match(/Version:\s*([\d.]+)/)?.[1] || 'unknown';
const isCJSBundle = !isGraph; // legacy

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: cli.original.cjs (v${version}) ${isGraph ? `[graph: ${Object.keys(files).length} files]` : ''}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'═'.repeat(55)}\n`);

// unified search: gather all matches of a pattern across every loaded file.
// validate() receives the full file text so surrounding-context patterns keep working.
function collectMatches(p) {
  const out = []; // { file, match, matches }
  for (const [fname, content] of Object.entries(files)) {
    const matches = [...content.matchAll(p.pattern)];
    if (matches.length === 0) continue;
    let rel = matches;
    // per-file validate / selectIndex — but these were designed for a single
    // bundle string. For graph, the pattern is applied per file, so each file
    // is an independent unit. validate() sees that file's content.
    if (p.validate) rel = matches.filter((m) => p.validate(m[0], content));
    out.push({ file: fname, content, matches: rel });
  }
  return out;
}

let applied = 0, skipped = 0, failed = 0;

for (const p of patches) {
  const fileMatches = collectMatches(p);

  /*
   * Patch semantics per file:
   *  - If a file contains match(es), apply replacement to that file.
   *  - "unique" / "validate" / "selectIndex" still constrain within one file.
   *  - The overall patch reports applied once if ANY file changed.
   *  - The "already applied / sentinel / stale" logic: if NO file has any
   *    match, fall through to the sentinel-based diagnostics (same as legacy).
   */
  let fileChangedCount = 0;
  const relevantFiles = fileMatches.filter((fm) => fm.matches.length > 0);

  // unique: if the aggregated count is >1 *across files* but the pattern
  // should hit exactly once in the whole app, we only allow applying to a
  // single file. Legacy enforced uniqueness over the whole bundle string;
  // graph splits it per-file so each file normally has ≤1 match anyway.
  let totalMatches = 0;
  for (const fm of fileMatches) totalMatches += fm.matches.length;

  if (relevantFiles.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
      continue;
    }
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => Object.values(files).some((c) => c.includes(s)));
      if (stillPresent.length > 0) {
        console.log(`  ❌ ${p.name} — regex stale, sentinel still in source: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++;
        continue;
      }
      console.log(`  ✅ ${p.name} (already applied, sentinel absent)`);
      applied++;
      continue;
    }
    console.log(`  ⚠️  ${p.name} (0 matches, no sentinel — cannot verify)`);
    skipped++;
    continue;
  }

  if (verify) {
    console.log(`  ⬚  ${p.name} — ${totalMatches} match(es), not yet applied`);
    skipped++;
    continue;
  }

  // Apply per file. For "unique" patches that would match in multiple files,
  // only apply to the first (they are expected to be single-site).
  const uniqueLimit = p.unique ? 1 : Infinity;
  let appliedFiles = 0;
  for (const fm of relevantFiles) {
    if (appliedFiles >= uniqueLimit) break;
    let changed = false;
    let count = 0;
    for (const m of fm.matches) {
      const replacement = p.replacer(m[0], ...m.slice(1));
      if (replacement !== m[0]) {
        if (!dryRun) {
          files[fm.file] = files[fm.file].replace(m[0], () => replacement);
        } else {
          // in dry-run mutate the local copy only for counting
          const tmp = fm.content;
          files[fm.file] = tmp.replace(m[0], () => replacement);
        }
        changed = true;
        count++;
      }
    }
    if (changed) appliedFiles++;
    fileChangedCount += count;
  }

  if (fileChangedCount > 0) {
    console.log(`  ✅ ${p.name} (${fileChangedCount} replacement${fileChangedCount > 1 ? 's' : ''} in ${appliedFiles} file${appliedFiles > 1 ? 's' : ''})`);
    applied++;
  } else if (relevantFiles.length > 0) {
    console.log(`  ⏭  ${p.name} (no change needed)`);
    skipped++;
  }
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${failed} failed`);

if (!dryRun && !verify && applied > 0) {
  // backup the entry (legacy semantics); graph writes all files in place
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log(`  📦 Backup: ${BACKUP}`);
  }
  for (const [fname, content] of Object.entries(files)) {
    writeFileSync(fname, content, 'utf8');
  }
  const origSize = isGraph ? 0 : (readFileSync(BACKUP, 'utf8').length || 0);
  console.log(`  📝 Written: ${Object.keys(files).length} file(s) ${isGraph ? '(graph)' : ''}`);
}

console.log(`${'═'.repeat(55)}\n`);
if (failed > 0) process.exitCode = 1;
'@

Set-Content (Join-Path $ClawDir "patch.mjs") $patcherCode -Encoding UTF8
Write-OK "Patcher created (patch.mjs)"

# ─── Apply patches ────────────────────────────────────

Write-Dim "Applying patches ..."
node (Join-Path $ClawDir "patch.mjs")
if ($LASTEXITCODE -ne 0) {
    Write-Err "Patching failed (node exit $LASTEXITCODE). Installation aborted."
    exit $LASTEXITCODE
}

# ─── Create default configs ───────────────────────────

$featuresFile = Join-Path $ClawDir "features.json"
if (-not (Test-Path $featuresFile)) {
    $featuresJson = @'
{
  "tengu_harbor": true,
  "tengu_session_memory": true,
  "tengu_amber_flint": true,
  "tengu_auto_background_agents": true,
  "tengu_destructive_command_warning": true,
  "tengu_immediate_model_command": true,
  "tengu_desktop_upsell": false,
  "tengu_malort_pedway": {"enabled": true},
  "tengu_amber_quartz_disabled": false,
  "tengu_prompt_cache_1h_config": {"allowlist": ["*"]},
  "tengu_amber_redwood3": "enabled"
}
'@
    [System.IO.File]::WriteAllText($featuresFile, $featuresJson, (New-Object System.Text.UTF8Encoding $false))
    Write-OK "Default features.json created"
}

# ─── Lean mode: optimize ~/.claude/settings.json ─────
$leanOffFlag = Join-Path $ClawDir ".lean-disabled"
$leanMaxFlag = Join-Path $ClawDir ".lean-max"
$claudeSettingsDir = Join-Path $env:USERPROFILE ".claude"
$claudeSettings = Join-Path $claudeSettingsDir "settings.json"
New-Item -ItemType Directory -Force -Path $claudeSettingsDir | Out-Null

if ($LeanOff) {
    New-Item -ItemType File -Force -Path $leanOffFlag | Out-Null
    if (Test-Path $leanMaxFlag) { Remove-Item $leanMaxFlag -Force }
    $leanRemoveScript = @'
const fs=require("fs"),p=process.argv[1];
const allDeny=new Set(["DesignSync","NotebookEdit","PushNotification","RemoteTrigger","CronCreate","CronDelete","CronList","EnterPlanMode","ExitPlanMode","SendMessage","ScheduleWakeup","AskUserQuestion","ReportFindings"]);
const allFlags=["disableWorkflows","disableRemoteControl","disableClaudeAiConnectors","disableArtifact","disableBundledSkills"];
let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{process.exit(0)}
for(const k of allFlags)delete s[k];
if(Array.isArray(s.permissions?.deny))s.permissions.deny=s.permissions.deny.filter(t=>!allDeny.has(t));
fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");
'@
    if (Test-Path $claudeSettings) {
        try { node -e $leanRemoveScript "$claudeSettings" 2>$null } catch {}
    }
    Write-OK "Lean mode disabled (all tools restored)"
} elseif ($LeanOn) {
    if (Test-Path $leanOffFlag) { Remove-Item $leanOffFlag -Force }
    if (Test-Path $leanMaxFlag) { Remove-Item $leanMaxFlag -Force }
} elseif ($LeanMax) {
    if (Test-Path $leanOffFlag) { Remove-Item $leanOffFlag -Force }
    New-Item -ItemType File -Force -Path $leanMaxFlag | Out-Null
}

if (-not (Test-Path $leanOffFlag)) {
    $leanIsMax = (Test-Path $leanMaxFlag)
    $leanApplyScript = @'
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
'@
    try {
        node -e $leanApplyScript "$claudeSettings" "$leanIsMax" 2>$null
        if ($leanIsMax) { Write-OK "Lean settings applied: max (~/.claude/settings.json)" }
        else { Write-OK "Lean settings applied: on (~/.claude/settings.json)" }
    } catch {}
} else {
    Write-Host "  $([char]0x2022) Lean mode disabled (claude --lean-on to re-enable)" -ForegroundColor DarkGray
}

# ─── Sanity check: ensure user's Bun can actually load cli.original.cjs ──
# Anthropic builds the native binary with a bleeding-edge Bun build (e.g.
# 1.3.14 while stable still ships 1.3.13). Older Bun crashes loading the
# extracted cli.original.cjs with "Expected CommonJS module to have a
# function wrapper". Detect this BEFORE we install the launcher — better
# to fail loudly than to leave the user with a launcher that panics on
# first invocation.

Write-Dim "Verifying Bun can load patched cli.original.cjs ..."
$sanityCli = Join-Path $ClawDir "cli.cjs"
# PowerShell folds native-command stderr into the error stream as
# ErrorRecord objects; with $ErrorActionPreference='Stop' (common when
# this script is piped through `iex`) that terminates BEFORE we even
# read $sanityOut. Localize ErrorActionPreference + try/catch so the
# panic message reliably lands in $sanityOut and our friendly Write-Err
# block runs. Defense-in-depth — pre-flight already blocks Bun < $MinBunVersion;
# this remains for the day Anthropic bumps embedded Bun past our constant.
$sanityOut = $null
try {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sanityOut = (& $BunBin $sanityCli --version 2>&1 | Out-String)
    $sanityExitCode = $LASTEXITCODE
} catch {
    $sanityOut = "$_"
    $sanityExitCode = 1
} finally {
    $ErrorActionPreference = $prevEAP
}
if ($sanityOut -match "Expected CommonJS module to have a function wrapper") {
    Write-Host ""
    Write-Err "Bun $(& $BunBin --version) cannot load Anthropic's cli.original.cjs."
    Write-Err ""
    Write-Err "  Anthropic builds with Bun's canary channel (currently ~1.3.14), while"
    Write-Err "  bun.sh's main download is on stable (currently 1.3.13). The canary build"
    Write-Err "  is NOT visible on bun.sh's download page — it lives on GitHub Releases"
    Write-Err "  and is reachable only via 'bun upgrade --canary'."
    Write-Err ""
    Write-Err "  If your bun is from bun.sh:"
    Write-Err "    bun upgrade --canary"
    Write-Err "    or: powershell -c ""iex & {`$(irm https://bun.sh/install.ps1)} -Version canary"""
    Write-Err ""
    Write-Err "  If your bun is from scoop (the binary is behind a shim and refuses to"
    Write-Err "  self-replace, so 'bun upgrade' silently hangs):"
    Write-Err "    scoop uninstall bun"
    Write-Err "    irm https://bun.sh/install.ps1 | iex"
    Write-Err "    bun upgrade --canary"
    Write-Err ""
    Write-Err "  Then re-run .\install.ps1 — this sanity check will pass."
    exit 1
}
if ($sanityExitCode -ne 0) {
    Write-Host ""
    Write-Err "Patched Claude failed its startup check (exit $sanityExitCode):"
    Write-Err "$sanityOut"
    exit $sanityExitCode
}
Write-OK "Bun loads cli.original.cjs"

# ─── Replace claude command ───────────────────────────

# Build launcher content using %USERPROFILE% env var where possible to avoid
# encoding issues when the profile path contains non-ASCII characters (e.g.
# Chinese/Korean/Japanese usernames). cmd.exe resolves %USERPROFILE% at
# runtime so no problematic characters need to be baked into the .cmd file.
$cliPathInCmd = "%USERPROFILE%\.clawgod\cli.cjs"
$normalizedUserProfile = $env:USERPROFILE.TrimEnd('\', '/')
$normalizedBunBin = $BunBin.TrimEnd('\', '/')
$userProfilePrefix = "$normalizedUserProfile\"
if ($normalizedBunBin.Equals($normalizedUserProfile, [StringComparison]::OrdinalIgnoreCase) -or
    $normalizedBunBin.StartsWith($userProfilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $bunRelative = $normalizedBunBin.Substring($normalizedUserProfile.Length).TrimStart('\', '/')
    $bunPathInCmd = "%USERPROFILE%\$bunRelative"
} else {
    # Bun outside USERPROFILE (e.g. system-wide install) — fall back to
    # absolute path since %USERPROFILE%-relative expansion doesn't apply.
    $bunPathInCmd = $BunBin
}
# Download clawgod-import binary
$importBin = Join-Path $ClawDir "clawgod-import.exe"
if (-not (Test-Path $importBin)) {
    $importUrl = "https://github.com/0Chencc/clawgod/releases/latest/download/clawgod-import-windows-x64.exe"
    try {
        Invoke-WebRequest -Uri $importUrl -OutFile $importBin -UseBasicParsing -ErrorAction Stop
        Write-OK "Provider import tool installed (clawgod-import.exe)"
    } catch {
        Write-Dim "Provider import tool not yet available (build pending)"
    }
}

$importPathInCmd = "%USERPROFILE%\.clawgod\clawgod-import.exe"
$launcherContent = "@echo off`r`nif `"%~1`"==`"import`" (`r`n  if exist `"$importPathInCmd`" (`r`n    shift`r`n    `"$importPathInCmd`" %1 %2 %3 %4 %5 %6 %7 %8 %9`r`n    exit /b %ERRORLEVEL%`r`n  ) else (`r`n    echo clawgod: import tool not installed. Reinstall clawgod to get it.`r`n    exit /b 127`r`n  )`r`n)`r`nif not exist `"$cliPathInCmd`" (`r`n  echo clawgod: cli.cjs not found. Reinstall: irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 ^| iex`r`n  exit /b 127`r`n)`r`nif not exist `"$bunPathInCmd`" (`r`n  echo clawgod: bun not found at $bunPathInCmd. Install: https://bun.sh/install`r`n  exit /b 127`r`n)`r`nset `"CLAUDE_CODE_EXECPATH=%~dp0claude.orig.exe`"`r`n`"$bunPathInCmd`" `"$cliPathInCmd`" %*"

# Find and back up original claude
$claudeCmd = Join-Path $BinDir "claude.cmd"
$claudeExe = Join-Path $BinDir "claude.exe"
$claudeOrigCmd = Join-Path $BinDir "claude.orig.cmd"
$claudeOrigExe = Join-Path $BinDir "claude.orig.exe"

# Check multiple locations for original claude
$originalFound = $false
foreach ($loc in @(
    (Join-Path $BinDir "claude.exe"),
    (Join-Path $BinDir "claude.cmd"),
    (Join-Path $env:USERPROFILE ".local\share\claude\versions"),
    (Join-Path $env:LOCALAPPDATA "Programs\claude-code")
)) {
    if (Test-Path $loc) {
        # Back up .exe if exists and not already backed up
        if ($loc -like "*.exe" -and -not (Test-Path $claudeOrigExe)) {
            Copy-Item $loc $claudeOrigExe -Force
            Write-OK "Original claude.exe backed up → claude.orig.exe"
            $originalFound = $true
        }
        # Back up .cmd if exists and not already backed up
        if ($loc -like "*.cmd" -and -not (Test-Path $claudeOrigCmd)) {
            Copy-Item $loc $claudeOrigCmd -Force
            Write-OK "Original claude.cmd backed up → claude.orig.cmd"
            $originalFound = $true
        }
        # If it's a versions directory, find the latest exe
        if (Test-Path $loc -PathType Container) {
            $latestExe = Get-ChildItem $loc -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($latestExe -and -not (Test-Path $claudeOrigExe)) {
                Copy-Item $latestExe.FullName $claudeOrigExe -Force
                Write-OK "Original claude backed up → claude.orig.exe ($($latestExe.Name))"
                $originalFound = $true
            }
        }
        break
    }
}

# Clean up leftover timestamped/old exes from previous installs
Get-ChildItem $BinDir -Filter "claude.*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "claude.orig.exe" } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# Remove claude.exe so .cmd takes precedence
# Keep one backup as claude.orig.exe, discard the rest
if (Test-Path $claudeExe) {
    if (-not (Test-Path $claudeOrigExe)) {
        Rename-Item $claudeExe $claudeOrigExe -Force
        Write-OK "Renamed claude.exe → claude.orig.exe"
    } else {
        # Backup already exists — just remove the new claude.exe
        try {
            Remove-Item -Force $claudeExe
        } catch {
            # File locked (running process) — rename aside with timestamp
            $ts = Get-Date -Format "yyyyMMddHHmmss"
            Rename-Item $claudeExe "claude.$ts.exe" -Force -ErrorAction SilentlyContinue
        }
        Write-OK "Removed claude.exe (.cmd now takes priority)"
    }
}


# Write .cmd launcher for both 'claude' and the explicit 'clawgod' alias.
# Why both:
#  - claude.cmd may be shadowed by a claude.exe higher in PATH
#  - clawgod.cmd has no .exe competitor, so it always works
#  - User can invoke patched explicitly via `clawgod` regardless of which
#    binary 'claude' resolves to
foreach ($cmd in @("claude", "clawgod")) {
    $launcherContent | Set-Content (Join-Path $BinDir "$cmd.cmd") -Encoding Default
}
Write-OK "Commands 'claude' + 'clawgod' → patched"

# ─── Ensure BinDir is in PATH ─────────────────────────

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
    $env:Path = "$BinDir;$env:Path"
    Write-OK "Added $BinDir to user PATH"
    Write-Dim "(restart terminal for PATH to take effect)"
}

# ─── Done ─────────────────────────────────────────────

Write-Host ""
Write-Host "  ClawGod installed!" -ForegroundColor Green
Write-Host ""
Write-Dim "  claude            — Start patched Claude Code (green logo)"
Write-Dim "  claude.orig       — Run original unpatched Claude Code"
Write-Host ""
Write-Dim "  Updates: 'claude update' is patched to route through this installer."
Write-Dim "  Just run it as usual — pulls latest Anthropic release + re-patches"
Write-Dim "  in one step. Extra options:"
Write-Dim "    claude update --version 2.1.180   (install a specific version)"
Write-Dim "    claude update --no-upgrade        (re-patch without downloading)"
Write-Dim "  To leave clawgod and use vanilla update:"
Write-Dim "    bash ~/.clawgod/install.sh --uninstall"
Write-Host ""
Write-Err "  If 'claude' still runs the old version, restart your terminal."
Write-Host ""
Write-Dim "  Config: ~/.clawgod/provider.json"
Write-Dim "  Flags:  ~/.clawgod/features.json"
Write-Host ""
Write-Dim "  If 'claude' panics with 'Expected CommonJS module to have a function wrapper',"
Write-Dim "  your Bun lags Anthropic's embedded Bun. Upgrade with one of:"
Write-Dim "    bun upgrade --canary           (if installed from bun.sh)"
Write-Dim "    scoop update bun               (scoop — may lag stable)"
Write-Dim "    irm https://bun.sh/install.ps1 | iex   (re-install latest)"
Write-Host ""
