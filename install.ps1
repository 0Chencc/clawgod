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
    .\install.ps1 -Uninstall
#>
param(
    [string]$Version = "latest",
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ClawDir = Join-Path $env:USERPROFILE ".clawgod"
$BinDir  = Join-Path $env:USERPROFILE ".local\bin"

# ─── Colors ───────────────────────────────────────────

function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }
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

    foreach ($f in @("cli.js","cli.cjs","cli.original.js","cli.original.cjs","cli.original.js.bak","cli.original.cjs.bak","patch.js","patch.mjs","extract-natives.mjs","post-process.mjs","repatch.mjs",".source-version","node_modules")) {
        $p = Join-Path $ClawDir $f
        if (Test-Path $p) { Remove-Item -Recurse -Force $p }
    }
    Write-OK "ClawGod uninstalled"
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
Write-OK "Bun: $(& $BunBin --version)"

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

# ─── Locate native Bun binary (must be present — cli.js source) ───────

New-Item -ItemType Directory -Force -Path $ClawDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null

$NativeBin = $null
$searchPaths = @(
    (Join-Path $env:USERPROFILE ".local\share\claude\versions"),
    (Join-Path $env:LOCALAPPDATA "Programs\claude-code")
)

foreach ($dir in $searchPaths) {
    if (Test-Path $dir -PathType Container) {
        $candidates = Get-ChildItem $dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*.exe" -or $_.Extension -eq "" } |
            Where-Object { $_.Length -gt 10MB } |
            Sort-Object LastWriteTime -Descending
        if ($candidates) {
            $NativeBin = $candidates[0].FullName
            break
        }
    }
}

# Also check backed-up claude.orig.exe
if (-not $NativeBin) {
    $origExe = Join-Path $BinDir "claude.orig.exe"
    if ((Test-Path $origExe) -and (Get-Item $origExe).Length -gt 10MB) {
        $NativeBin = $origExe
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

const CLI_PATH_MARKER = Buffer.from('file:///$bunfs/root/src/entrypoints/cli.js');
const CLI_FN_MARKER = Buffer.from('(function(exports, require, module');
const CLI_TAIL_MARKER = Buffer.from('cli_after_main_complete")}');
const CLI_END_MARKER = Buffer.from(');})');

function extractCliJs(buf) {
  const pathOff = buf.indexOf(CLI_PATH_MARKER);
  if (pathOff === -1) return null;
  const fnStart = buf.indexOf(CLI_FN_MARKER, pathOff);
  if (fnStart === -1 || fnStart - pathOff > 1024) return null;
  const tailMark = buf.indexOf(CLI_TAIL_MARKER, fnStart);
  if (tailMark === -1) return null;
  const ending = buf.indexOf(CLI_END_MARKER, tailMark);
  if (ending === -1 || ending - tailMark > 4096) return null;
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
    console.log(`  cli.js  ${(js.length / 1024 / 1024).toFixed(2)} MB -> ${out}`);
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
'@ | Set-Content $extractorPath -Encoding UTF8

# ─── Extract cli.js + native modules from Bun binary ──────────

$VendorDir = Join-Path $ClawDir "vendor"
if (Test-Path $VendorDir) { Remove-Item -Recurse -Force $VendorDir }
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

$dstCli = Join-Path $ClawDir "cli.original.js"

Write-Dim "Extracting cli.js from $(Split-Path $NativeBin -Leaf) ..."
& node $extractorPath $NativeBin $ClawDir --cli-js 2>&1 | ForEach-Object { Write-Host "  $_" }
if (-not (Test-Path $dstCli)) {
    Write-Err "Failed to extract cli.js from native binary"
    exit 1
}

Write-Dim "Extracting native modules from $(Split-Path $NativeBin -Leaf) ..."
& node $extractorPath $NativeBin $VendorDir 2>&1 | ForEach-Object { Write-Host "  $_" }

# Note: keep extractorPath around — repatch.mjs uses it on version drift

# ─── Post-process cli.js for Bun runtime ──────────────────────

Write-Dim "Rewriting bunfs paths and IIFE invocation ..."
$postProc = Join-Path $ClawDir "post-process.mjs"
@'
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;

let code = readFileSync(src, 'utf8');

code = code.replace(
  /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
  (m, _full, name) =>
    `require(require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')}))`,
);

code = code.replace(
  /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
  () => '__filename',
);

code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

writeFileSync(dst, code);
unlinkSync(src);
console.log(`cli.original.cjs: ${code.length} bytes`);
'@ | Set-Content $postProc -Encoding UTF8
& node $postProc 2>&1 | ForEach-Object { Write-Host "  $_" }
if (-not (Test-Path (Join-Path $ClawDir "cli.original.cjs"))) {
    Write-Err "Post-process failed"
    exit 1
}

# Stamp source version so wrapper can detect drift on next launch
Set-Content -Path (Join-Path $ClawDir ".source-version") -Value (Split-Path $NativeBin -Leaf) -Encoding ASCII
Write-OK "cli.original.cjs ready ($(Split-Path $NativeBin -Leaf))"

# ─── Write re-patch helper (used by wrapper on version drift) ─────────

@'
#!/usr/bin/env bun
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
'@ | Set-Content (Join-Path $ClawDir "repatch.mjs") -Encoding UTF8
Write-OK "Re-patch helper installed (repatch.mjs)"

# ─── Write wrapper (cli.cjs, runs under Bun) ──────────────────

@'
#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } = require('fs');
const { join, basename } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const claudeDir = join(homedir(), '.claude');
const clawgodDir = join(homedir(), '.clawgod');

// Version drift detection — see install.sh wrapper for full notes.
try {
  const stamp = join(__dirname, '.source-version');
  const versionsDir = join(homedir(), '.local/share/claude/versions');
  if (existsSync(versionsDir)) {
    let latest = null, latestMtime = 0;
    for (const name of readdirSync(versionsDir)) {
      const p = join(versionsDir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || st.size < 10 * 1024 * 1024) continue;
      if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = p; }
    }
    if (latest) {
      const have = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
      const want = basename(latest);
      if (have && have !== want) {
        process.stderr.write(`[clawgod] new Claude version detected (${want}, was ${have}); re-patching...\n`);
        const repatch = join(__dirname, 'repatch.mjs');
        if (existsSync(repatch)) {
          const r = spawnSync(process.execPath, [repatch, latest], { stdio: 'inherit' });
          if (r.status !== 0) {
            process.stderr.write('[clawgod] re-patch failed; running previous patched copy\n');
          }
        }
      }
    }
  }
} catch (e) {
  process.stderr.write(`[clawgod] drift check skipped: ${e.message}\n`);
}
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

const hasProviderApiKey = !!config.apiKey;

if (hasProviderApiKey) {
  process.env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.baseURL) process.env.ANTHROPIC_BASE_URL = config.baseURL;
  if (config.model) process.env.ANTHROPIC_MODEL = config.model;
  if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
  process.env.CLAUDE_CONFIG_DIR = clawgodDir;
  if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
    process.env.ANTHROPIC_AUTH_TOKEN ??= config.apiKey;
  }
} else {
  if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
    process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
  }
  process.env.CLAUDE_CONFIG_DIR ??= configDir;
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

require('./cli.original.cjs');
'@ | Set-Content (Join-Path $ClawDir "cli.cjs") -Encoding UTF8
Write-OK "Wrapper created (cli.cjs)"

# ─── Write universal patcher ──────────────────────────
# (Same Node.js patcher as bash version — extract from install.sh or inline)

$patcherUrl = "https://raw.githubusercontent.com/0Chencc/clawgod/main/patcher.mjs"

# Inline the patcher to avoid extra download
$patcherCode = @'
#!/usr/bin/env node
/**
 * ClawGod Universal Patcher
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, 'cli.original.cjs');
const BACKUP = TARGET + '.bak';

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
    unique: true,
  },
  {
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){try{return j8().growthBookOverrides??null}catch{return null}}${next}`,
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
    // v2.1.92+: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
    sentinel: 'name:"ultraplan"',
  },
  {
    name: 'Ultrareview enable',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn) => `function ${fn}(){return{enabled:!0}}`,
    sentinel: '"tengu_review_bughunter_config"',
  },
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
    name: 'Auto-mode unlock for third-party API',
    pattern: /let ([\w$]+)=[\w$]+\(\);if\(\1!=="firstParty"&&\1!=="anthropicAws"\)return!1;/g,
    replacer: () => '',
    sentinel: '!=="firstParty"&&',
  },
  {
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
  },
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
    pattern: /function ([\w$]+)\(\)\{return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn) => `function ${fn}(){return\`\`}`,
    sentinel: '# Executing actions with care',
  },
  {
    name: 'Remove "Not logged in" notice',
    pattern: /Not logged in\. Run [\w ]+ to authenticate\./g,
    replacer: () => '',
    optional: true,
  },
  {
    name: 'Attachment filter bypass',
    pattern: /([\w$]+)\(\)!=="ant"(&&[\w$]+\.has\([\w$]+\.attachment\.type\)|\)\{if\([\w$]+\.attachment\.type==="hook_additional_context")/g,
    replacer: (m) => m.replace(/([\w$]+)\(\)!=="ant"/, 'false'),
    optional: true,
  },
  {
    name: 'Message list filter bypass (legacy ternary)',
    pattern: /([\w$]+)\(\)!=="ant"\?([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+)\)\):([\w$]+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => fallback,
    optional: true,
  },
  {
    name: 'Message list filter bypass (s_8 form)',
    pattern: /if\(([\w$]+)\(\)==="ant"\)return ([\w$]+);let ([\w$]+)=([\w$]+) instanceof Set\?\4:([\w$]+)\(\4\);return ([\w$]+)\(\2,\3\)/g,
    replacer: (m, fn, ret) => `return ${ret}`,
    optional: true,
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');

if (revert) {
  if (!existsSync(BACKUP)) { console.error('No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('Reverted from backup');
  process.exit(0);
}

if (!existsSync(TARGET)) {
  console.error('Target not found:', TARGET);
  process.exit(1);
}

let code = readFileSync(TARGET, 'utf8');
const origSize = code.length;
const verMatch = code.match(/Version:\s*([\d.]+)/);
const version = verMatch ? verMatch[1] : 'unknown';

console.log(`\n${'='.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: cli.original.cjs (v${version})`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'='.repeat(55)}\n`);

let applied = 0, skipped = 0, failed = 0;

for (const p of patches) {
  const matches = [...code.matchAll(p.pattern)];
  let relevant = matches;
  if (p.validate) relevant = matches.filter(m => p.validate(m[0], code));
  if (p.selectIndex !== undefined) relevant = relevant.length > p.selectIndex ? [relevant[p.selectIndex]] : [];
  if (p.unique && relevant.length > 1) {
    console.log(`  ?? ${p.name} — ${relevant.length} matches (need 1)`);
    failed++; continue;
  }
  if (relevant.length === 0) {
    if (p.optional) { console.log(`  >> ${p.name} (not in this version)`); skipped++; continue; }
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => code.includes(s));
      if (stillPresent.length > 0) {
        console.log(`  XX ${p.name} — regex stale, sentinel still present: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++; continue;
      }
      console.log(`  OK ${p.name} (already applied, sentinel absent)`); applied++; continue;
    }
    console.log(`  !! ${p.name} (0 matches, no sentinel)`); skipped++;
    continue;
  }
  if (verify) { console.log(`  -- ${p.name} — not yet applied`); skipped++; continue; }
  let count = 0;
  for (const m of relevant) {
    const replacement = p.replacer(m[0], ...m.slice(1));
    if (replacement !== m[0]) { if (!dryRun) code = code.replace(m[0], replacement); count++; }
  }
  if (count > 0) { console.log(`  OK ${p.name} (${count})`); applied++; }
  else { console.log(`  >> ${p.name} (no change)`); skipped++; }
}

console.log(`\n${'-'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${failed} failed`);

if (!dryRun && !verify && applied > 0) {
  if (!existsSync(BACKUP)) { copyFileSync(TARGET, BACKUP); console.log(`  Backup: ${BACKUP}`); }
  writeFileSync(TARGET, code, 'utf8');
  console.log(`  Written: cli.original.cjs (${code.length - origSize} bytes)`);
}
console.log(`${'='.repeat(55)}\n`);
'@

Set-Content (Join-Path $ClawDir "patch.mjs") $patcherCode -Encoding UTF8
Write-OK "Patcher created (patch.mjs)"

# ─── Apply patches ────────────────────────────────────

Write-Dim "Applying patches ..."
node (Join-Path $ClawDir "patch.mjs")

# ─── Create default configs ───────────────────────────

$featuresFile = Join-Path $ClawDir "features.json"
if (-not (Test-Path $featuresFile)) {
    @'
{
  "tengu_harbor": true,
  "tengu_session_memory": true,
  "tengu_amber_flint": true,
  "tengu_auto_background_agents": true,
  "tengu_destructive_command_warning": true,
  "tengu_immediate_model_command": true,
  "tengu_desktop_upsell": false,
  "tengu_prompt_cache_1h_config": {"allowlist": ["*"]}
}
'@ | Set-Content $featuresFile -Encoding UTF8
    Write-OK "Default features.json created"
}

# ─── Replace claude command ───────────────────────────

$cliPath = (Join-Path $ClawDir "cli.cjs") -replace '\\', '\\'
$bunPath = $BunBin -replace '\\', '\\'
$launcherContent = "@echo off`r`n`"$bunPath`" `"$cliPath`" %*"

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
    $launcherContent | Set-Content (Join-Path $BinDir "$cmd.cmd") -Encoding ASCII
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
Write-Err "  If 'claude' still runs the old version, restart your terminal."
Write-Host ""
Write-Dim "  Config: ~/.clawgod/provider.json"
Write-Dim "  Flags:  ~/.clawgod/features.json"
Write-Host ""
