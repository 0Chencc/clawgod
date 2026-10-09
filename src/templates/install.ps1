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

# --- Colors -----------------------------------------------------------

function Write-OK($msg)   { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  $([char]0x2717) $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Dim($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ClawGod Installer" -ForegroundColor White -NoNewline
Write-Host " (Windows)" -ForegroundColor DarkGray
Write-Host ""

# --- Uninstall --------------------------------------------------------

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

    foreach ($f in @("cli.js","cli.cjs","cli.original.js","cli.original.cjs","cli.original.js.bak","cli.original.cjs.bak","source-backup.json","patch.js","patch.mjs","extract-natives.mjs","post-process.mjs","repatch.mjs","startup-check.cjs","startup-check.log","openai-proxy.cjs","feature-gates.cjs","runtime-helpers.cjs","bun-ant-shim.cjs","clawgod-import.exe","claude.staged.exe",".source-version","node_modules","bun-runtime","vendor","bunfs","pathmap.json")) {
        $p = Join-Path $ClawDir $f
        if (Test-Path $p) { Remove-Item -Recurse -Force $p }
    }
    Write-OK "ClawGod uninstalled"
    Write-Host ""
    Write-Dim "Restart your terminal for changes to take effect."
    Write-Host ""
    exit 0
}

# --- Prerequisites ----------------------------------------------------

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

# --- Ensure Bun (runtime that executes the patched cli.js) ------------

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

# Resolve bun.ps1 -> bun.exe. When Bun is installed via `npm install -g bun`,
# Get-Command returns a .ps1 wrapper script. A .cmd launcher cannot invoke .ps1
# directly -- Windows opens the file association dialog instead of executing it.
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
        Write-Dim "Resolved bun.ps1 -> $resolved"
        $BunBin = $resolved
    } else {
        Write-Warn "Bun resolved to .ps1 wrapper ($BunBin). The launcher may not work."
        Write-Warn "Consider installing Bun via bun.sh/install.ps1 for a native bun.exe."
    }
}
Write-OK "Bun: $(& $BunBin --version)"

# --- Bun version pre-flight -------------------------------------------
# Anthropic builds the native binary with Bun's canary channel; stable
# bun.sh trails by one version. Bun < 1.3.14 panics on cli.original.cjs
# with "Expected CommonJS module to have a function wrapper". Refuse
# early -- no npm download / no patch / no late sanity surprise where
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

# --- ripgrep prerequisite (search/grep tool) --------------------------
# Hard prerequisite -- without rg the Grep tool inside Claude Code fails.

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

# --- Handle -NoUpgrade (re-patch the installed version) --------------
if ($NoUpgrade) {
    New-Item -ItemType Directory -Force -Path $ClawDir | Out-Null
    New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null
    $existingCjs = Join-Path $ClawDir "cli.original.cjs"
    if (-not (Test-Path $existingCjs)) {
        Write-Err "-NoUpgrade requires an existing installation."
        Write-Err "Run a full install first (without -NoUpgrade)."
        exit 1
    }
    if (Test-Path (Join-Path $ClawDir 'source-backup.json')) {
        Write-OK "Using complete clean-source backup (-NoUpgrade)"
    } else {
        # Older installers backed up only the entry, not bunfs chunks. Recover
        # clean source from the exact installed version, never from latest.
        $versionStamp = Join-Path $ClawDir '.source-version'
        $installedVersion = [regex]::Match('', '^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$')
        if (Test-Path $versionStamp) {
            $installedVersion = [regex]::Match((Get-Content $versionStamp -Raw).Trim(), '^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$')
        }
        if (-not $installedVersion.Success) {
            $installedVersion = [regex]::Match((Get-Content $existingCjs -Raw), 'Version:\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)')
        }
        if (-not $installedVersion.Success) {
            throw 'No complete source backup and installed version is unknown. Reinstall with -Version <version>.'
        }
        $Version = $installedVersion.Groups[1].Value
        $NoUpgrade = [switch]$false
        Write-OK "Recovering clean source for installed version $Version (one-time download, no version upgrade)"
    }
}
if (-not $NoUpgrade) {

# --- Locate native Bun binary (cli.js source) -------------------------
# Source: npm registry (@anthropic-ai/claude-code-win32-<arch>).
# Local binary detection is intentionally skipped -- see policy note below.

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
# here) would re-detect the frozen binary forever -- never reaching the
# registry. See INCIDENT_LOG 2026-04-29 entry. The fix is to skip local
# detection entirely; the npm tarball is ~60-90 MB compressed, fetched
# once per upgrade.

# npm registry -- pull the platform tarball directly via Node.
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
            Write-Dim "NO_PROXY includes npmjs.org -- using direct fetch"
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
{{CLAWGOD:npm-fetch.mjs}}
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

# --- Snapshot existing installation for rollback on failure ----------
$RollbackDir = $null
$script:RollbackPending = $false
$RollbackFiles = @("cli.original.cjs","cli.original.cjs.bak","cli.original.js",".source-version",
    "source-backup.json","bunfs","vendor","pathmap.json","extract-natives.mjs","post-process.mjs",
    "repatch.mjs","openai-proxy.cjs","feature-gates.cjs","cli.cjs",".clawgod-version",
    "startup-check.cjs","runtime-helpers.cjs","bun-ant-shim.cjs","patch.mjs")
$origCjs = Join-Path $ClawDir "cli.original.cjs"
$sourceVerFile = Join-Path $ClawDir ".source-version"
if ((Test-Path $origCjs) -and (Test-Path $sourceVerFile)) {
    $RollbackDir = Join-Path ([System.IO.Path]::GetTempPath()) ("clawgod-rollback-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $RollbackDir -Force | Out-Null
    try {
        foreach ($f in $RollbackFiles) {
            $path = Join-Path $ClawDir $f
            if (Test-Path $path) { Copy-Item -LiteralPath $path -Destination $RollbackDir -Recurse -Force -ErrorAction Stop }
        }
    } catch {
        Remove-Item -LiteralPath $RollbackDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Could not snapshot existing installation; installation was not changed: $_"
    }
}

function Restore-Install {
    Remove-Item -LiteralPath (Join-Path $ClawDir "claude.staged.exe") -Force -ErrorAction SilentlyContinue
    if (-not $script:RollbackPending) { return }
    $script:RollbackPending = $false
    if (-not $RollbackDir) { return }
    Write-Dim "Rolling back to previous working installation ..."
    try {
        foreach ($f in $RollbackFiles) {
            $path = Join-Path $ClawDir $f
            if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
        }
        Get-ChildItem -LiteralPath $RollbackDir -Force | Copy-Item -Destination $ClawDir -Recurse -Force -ErrorAction Stop
        Write-OK "Restored previous working installation ($((Get-Content $sourceVerFile -Raw).Trim()))."
        Remove-Item -LiteralPath $RollbackDir -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Err "Rollback failed; backup kept at $RollbackDir : $_"
    }
}
$script:RollbackPending = $true
trap { Restore-Install; break }

# Always write the extractor (used for cli.js and/or .node modules)
$extractorPath = Join-Path $ClawDir "extract-natives.mjs"
@'
{{CLAWGOD:extract-natives.mjs}}
'@ | Set-Content $extractorPath -Encoding UTF8

# --- Extract cli.js + native modules from Bun binary ------------------

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
if (($LASTEXITCODE -ne 0) -or -not (Test-Path $dstCli)) {
    Write-Err "Failed to extract cli.js from native binary"
    Restore-Install
    exit 1
}

# Note: keep extractorPath around -- repatch.mjs uses it on version drift

# --- Post-process cli.js for Bun runtime -------------------------------

Write-Dim "Rewriting bunfs paths and IIFE invocation ..."
$postProc = Join-Path $ClawDir "post-process.mjs"
@'
{{CLAWGOD:post-process.mjs}}
'@ | Set-Content $postProc -Encoding UTF8
& node $postProc 2>&1 | ForEach-Object { Write-Host "  $_" }
if (($LASTEXITCODE -ne 0) -or -not (Test-Path (Join-Path $ClawDir "cli.original.cjs"))) {
    Write-Err "Post-process failed"
    Restore-Install
    exit 1
}

# Stamp source version so wrapper can detect drift on next launch
Set-Content -Path (Join-Path $ClawDir ".source-version") -Value $NativeBinLabel -Encoding ASCII

# Keep the binary we just extracted from. cli.cjs points process.execPath at
# claude.orig.exe, so everything Claude re-spawns from execPath (daemon,
# background and forked sessions) runs that file, not the patched bundle. The
# launcher section below swaps it in; staging through $ClawDir keeps that
# section independent of the download above.
if ($NativeBin -and (Test-Path $NativeBin)) {
    Move-Item -Force $NativeBin (Join-Path $ClawDir "claude.staged.exe")
}

# If we pulled the binary from npm into a tmpdir, clean up -- extraction
# is done; drift detection only consults %USERPROFILE%\.local\share\claude\versions\.
if ($NativeBinTmpDir -and (Test-Path $NativeBinTmpDir)) {
    Remove-Item -Recurse -Force $NativeBinTmpDir -ErrorAction SilentlyContinue
}

Write-OK "cli.original.cjs ready ($NativeBinLabel)"

}  # end -NoUpgrade skip

# A failed earlier upgrade may have left a newer native binary staged.
if ($NoUpgrade) {
    Remove-Item -LiteralPath (Join-Path $ClawDir "claude.staged.exe") -Force -ErrorAction SilentlyContinue
}

# --- Write re-patch helper (used by wrapper on version drift) ---------

@'
{{CLAWGOD:repatch.mjs}}
'@ | Set-Content (Join-Path $ClawDir "repatch.mjs") -Encoding UTF8
Write-OK "Re-patch helper installed (repatch.mjs)"

# --- Write OpenAI-compatible proxy ------------------------------------

# NOTE: PowerShell here-string @'...'@ cannot contain a line starting with '@
# The proxy source is identical to the install.sh version.
# $PSScriptRoot is empty when run via iex (e.g. claude update -> iex(irm $url)).
# Join-Path "" "file" throws a terminating error that -ErrorAction cannot catch.
try { $ProxySource = Get-Content (Join-Path $PSScriptRoot "openai-proxy.cjs") -Raw -ErrorAction Stop } catch { $ProxySource = $null }
if (-not $ProxySource) {
  # Inline fallback: fetch from release assets
  $ProxySource = @'
{{CLAWGOD:openai-proxy.cjs}}
'@
}
$ProxySource | Set-Content (Join-Path $ClawDir "openai-proxy.cjs") -Encoding UTF8
Write-OK "OpenAI-compatible proxy created (openai-proxy.cjs)"

# --- Write patch feature gates -----------------------------------------

@'
{{CLAWGOD:feature-gates.cjs}}
'@ | Set-Content (Join-Path $ClawDir "feature-gates.cjs") -Encoding UTF8
Write-OK "Patch feature gates created (feature-gates.cjs)"

# --- Write wrapper (cli.cjs, runs under Bun) --------------------------

@'
{{CLAWGOD:cli.cjs}}
'@ | Set-Content (Join-Path $ClawDir "cli.cjs") -Encoding UTF8
Set-Content (Join-Path $ClawDir ".clawgod-version") $ClawSelfVersion
Write-OK "Wrapper created (cli.cjs)"

@'
{{CLAWGOD:startup-check.cjs}}
'@ | Set-Content (Join-Path $ClawDir "startup-check.cjs") -Encoding UTF8

# --- Write classifier runtime helper -----------------------------------

@'
{{CLAWGOD:runtime-helpers.cjs}}
'@ | Set-Content (Join-Path $ClawDir "runtime-helpers.cjs") -Encoding UTF8
Write-OK "Classifier helper created (runtime-helpers.cjs)"

# --- Write Bun.ant runtime shim ---------------------------------------
# Claude Code 2.1.271+ renders through Bun.ant.CellSegmenter, an
# Anthropic-private Bun API that stock Bun does not ship. cli.cjs loads this
# shim before the bundle; without it the TUI never paints.

@'
{{CLAWGOD:bun-ant-shim.cjs}}
'@ | Set-Content (Join-Path $ClawDir "bun-ant-shim.cjs") -Encoding UTF8
Write-OK "Bun.ant runtime shim created (bun-ant-shim.cjs)"

# --- Write universal patcher ------------------------------------------
# (Same Node.js patcher as bash version -- inline to avoid extra download)

$patcherCode = @'
{{CLAWGOD:patch.mjs}}
'@

Set-Content (Join-Path $ClawDir "patch.mjs") $patcherCode -Encoding UTF8
Write-OK "Patcher created (patch.mjs)"

# --- Apply patches ----------------------------------------------------

if (-not $NoUpgrade) {
    node (Join-Path $ClawDir "patch.mjs") --capture-clean-source
    if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE; Restore-Install; exit $exitCode }
}
Write-Dim "Applying patches ..."
node (Join-Path $ClawDir "patch.mjs")
if ($LASTEXITCODE -ne 0) {
    $exitCode = $LASTEXITCODE
    Write-Err "Patching failed (node exit $exitCode). Installation aborted."
    if (-not $NoUpgrade) { Restore-Install }
    if (-not $RollbackDir) {
        Write-Err "No previous working installation found to roll back."
    }
    Write-Err ""
    Write-Err "The new Claude Code build ($NativeBinLabel) is not yet supported by this ClawGod release."
    Write-Err "To install or roll back to a known compatible version, run:"
    Write-Err "  & ([scriptblock]::Create((irm 'https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1'))) -Version <version>"
    Write-Err "(Note: 'claude update --version' will fail on unpatched Claude Code with 'unknown option --version')"
    exit $exitCode
}

# --- Report which renderer runtime this Claude Code build needs -------
# 2.1.271+ renders through Bun.ant.CellSegmenter, an Anthropic-private Bun
# API; cli.cjs answers it with bun-ant-shim.cjs. Older builds use plain Bun
# APIs and ignore the shim.
$needsShim = $false
$bunfsDir = Join-Path $ClawDir "bunfs"
$targets = @()
if (Test-Path $bunfsDir) {
    $targets += Get-ChildItem -Path $bunfsDir -File -ErrorAction SilentlyContinue
}
$entry = Join-Path $ClawDir "cli.original.cjs"
if (Test-Path $entry) { $targets += Get-Item $entry }
# Scan every extracted chunk (`.js` and `.mjs`) plus the entry point, matching
# the POSIX side, so the report fires when any of them references the API.
$hit = $targets |
    Select-String -Pattern 'Bun\.ant\.CellSegmenter' -List -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($hit) { $needsShim = $true }
if ($needsShim) {
    Write-Dim "Renderer runtime: Bun.ant.CellSegmenter (Claude >= 2.1.271) - served by bun-ant-shim.cjs"
} else {
    Write-Dim "Renderer runtime: stock Bun APIs (shim present but unused)"
}

# --- Create default configs -------------------------------------------

$featuresFile = Join-Path $ClawDir "features.json"
if (-not (Test-Path $featuresFile)) {
    $featuresJson = @'
{{CLAWGOD:features.json}}
'@
    [System.IO.File]::WriteAllText($featuresFile, $featuresJson, (New-Object System.Text.UTF8Encoding $false))
    Write-OK "Default features.json created"
}

# Patch feature toggles (user-editable): {"<feature>": false}, absent = on.
# Written only when missing -- the user's choices survive updates/uninstalls.
$patchesFile = Join-Path $ClawDir "patches.json"
if (-not (Test-Path $patchesFile)) {
    [System.IO.File]::WriteAllText($patchesFile, "{}`r`n", (New-Object System.Text.UTF8Encoding $false))
    Write-OK "Default patches.json created (all features on)"
}

# --- Lean mode: optimize ~/.claude/settings.json ----------------------
$leanOffFlag = Join-Path $ClawDir ".lean-disabled"
$leanMaxFlag = Join-Path $ClawDir ".lean-max"
$claudeSettingsDir = Join-Path $env:USERPROFILE ".claude"
$claudeSettings = Join-Path $claudeSettingsDir "settings.json"
New-Item -ItemType Directory -Force -Path $claudeSettingsDir | Out-Null

if ($LeanOff) {
    New-Item -ItemType File -Force -Path $leanOffFlag | Out-Null
    if (Test-Path $leanMaxFlag) { Remove-Item $leanMaxFlag -Force }
    $leanRemoveScript = @'
{{CLAWGOD:lean-remove.cjs}}
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
{{CLAWGOD:lean-apply.cjs}}
'@
    try {
        node -e $leanApplyScript "$claudeSettings" "$leanIsMax" 2>$null
        if ($leanIsMax) { Write-OK "Lean settings applied: max (~/.claude/settings.json)" }
        else { Write-OK "Lean settings applied: on (~/.claude/settings.json)" }
    } catch {}
} else {
    Write-Host "  $([char]0x2022) Lean mode disabled (claude --lean-on to re-enable)" -ForegroundColor DarkGray
}

# --- Sanity check: ensure user's Bun can load cli.original.cjs --------
# Anthropic builds the native binary with a bleeding-edge Bun build (e.g.
# 1.3.14 while stable still ships 1.3.13). Older Bun crashes loading the
# extracted cli.original.cjs with "Expected CommonJS module to have a
# function wrapper". Detect this BEFORE we install the launcher -- better
# to fail loudly than to leave the user with a launcher that panics on
# first invocation.

Write-Dim "Verifying Bun can load patched cli.original.cjs (bounded startup check) ..."
$sanityCli = Join-Path $ClawDir "cli.cjs"
# PowerShell folds native-command stderr into the error stream as
# ErrorRecord objects; with $ErrorActionPreference='Stop' (common when
# this script is piped through `iex`) that terminates BEFORE we even
# read $sanityOut. Localize ErrorActionPreference + try/catch so the
# panic message reliably lands in $sanityOut and our friendly Write-Err
# block runs. Defense-in-depth -- pre-flight already blocks Bun < $MinBunVersion;
# this remains for the day Anthropic bumps embedded Bun past our constant.
$sanityOut = $null
try {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sanityOut = (& node (Join-Path $ClawDir "startup-check.cjs") $BunBin $sanityCli 2>&1 | Out-String)
    $sanityExitCode = $LASTEXITCODE
} catch {
    $sanityOut = "$_"
    $sanityExitCode = 1
} finally {
    $ErrorActionPreference = $prevEAP
}
if ($sanityOut -match "Expected CommonJS module to have a function wrapper") {
    Write-Host ""
    Write-Err "The selected Bun runtime cannot load Anthropic's cli.original.cjs."
    Write-Err ""
    Write-Err "  Anthropic builds with Bun's canary channel (currently ~1.3.14), while"
    Write-Err "  bun.sh's main download is on stable (currently 1.3.13). The canary build"
    Write-Err "  is NOT visible on bun.sh's download page -- it lives on GitHub Releases"
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
    Write-Err "  Then re-run .\install.ps1 -- this sanity check will pass."
    if (-not $NoUpgrade) { Restore-Install }
    exit 1
}
if ($sanityExitCode -ne 0) {
    Write-Host ""
    Write-Err "Patched Claude failed its startup check (exit $sanityExitCode):"
    Write-Err "$sanityOut"
    if (-not $NoUpgrade) { Restore-Install }
    exit $sanityExitCode
}
Write-OK "Bun loads cli.original.cjs"
$script:RollbackPending = $false
if ($RollbackDir) { Remove-Item -LiteralPath $RollbackDir -Recurse -Force -ErrorAction SilentlyContinue }

# --- Replace claude command -------------------------------------------

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
    # Bun outside USERPROFILE (e.g. system-wide install) -- fall back to
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

# Refresh claude.orig.exe from the binary this run extracted. The backup below
# is only taken once, so without this it stays at whatever version was on disk
# at first install while cli.original.cjs moves on. Sessions spawned from
# process.execPath then report the old version to the API, which rejects
# models that need a newer client ("Claude Code 2.1.270 does not support this
# model") -- seen as a failed auto-compaction in background sessions.
$stagedNative = Join-Path $ClawDir "claude.staged.exe"
if (Test-Path $stagedNative) {
    $origInUse = $false
    if (Test-Path $claudeOrigExe) {
        try {
            Remove-Item -Force $claudeOrigExe
        } catch {
            # A running daemon holds the old exe. Same approach as claude.exe
            # below: rename it aside, the claude.*.exe sweep removes it on a
            # later install once nothing uses it.
            $origInUse = $true
            try {
                Rename-Item $claudeOrigExe "claude.$([Guid]::NewGuid().ToString('N')).exe" -ErrorAction Stop
            } catch {}
        }
    }
    if (Test-Path $claudeOrigExe) {
        # Not fatal: the patched CLI itself is fine, only spawned sessions lag.
        Remove-Item -Force $stagedNative -ErrorAction SilentlyContinue
        Write-Warn "Could not replace claude.orig.exe (in use). Background sessions stay on the old version."
        Write-Warn "Close all Claude Code sessions and rerun this installer."
    } else {
        Move-Item -Force $stagedNative $claudeOrigExe
        Write-OK "Native binary refreshed -> claude.orig.exe"
        if ($origInUse) {
            Write-Dim "Sessions started before this update keep the old binary until restarted."
        }
    }
}

# Check multiple locations for original claude
$originalFound = $false
foreach ($loc in @(
    (Join-Path $BinDir "claude.exe"),
    (Join-Path $BinDir "claude.cmd"),
    (Join-Path $env:USERPROFILE ".local\share\claude\versions"),
    (Join-Path $env:LOCALAPPDATA "Programs\claude-code")
)) {
    if (Test-Path $loc) {
        # Reinstalling must not back up our own launcher as the original.
        # Continue searching versions/ if no native executable was found yet.
        if ($loc -like "*.cmd" -and (Select-String -LiteralPath $loc -Pattern '\.clawgod[\\/]cli\.(?:cjs|js)' -Quiet)) {
            continue
        }
        # Back up .exe if exists and not already backed up
        if ($loc -like "*.exe" -and -not (Test-Path $claudeOrigExe)) {
            Copy-Item $loc $claudeOrigExe -Force
            Write-OK "Original claude.exe backed up -> claude.orig.exe"
            $originalFound = $true
        }
        # Back up .cmd if exists and not already backed up
        if ($loc -like "*.cmd" -and -not (Test-Path $claudeOrigCmd)) {
            Copy-Item $loc $claudeOrigCmd -Force
            Write-OK "Original claude.cmd backed up -> claude.orig.cmd"
            $originalFound = $true
        }
        # If it's a versions directory, find the latest exe
        if (Test-Path $loc -PathType Container) {
            $latestExe = Get-ChildItem $loc -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($latestExe -and -not (Test-Path $claudeOrigExe)) {
                Copy-Item $latestExe.FullName $claudeOrigExe -Force
                Write-OK "Original claude backed up -> claude.orig.exe ($($latestExe.Name))"
                $originalFound = $true
            }
        }
        break
    }
}

# Write both entry points before removing a competing exe. If Windows refuses
# removal, the explicit clawgod command remains available for recovery.
foreach ($cmd in @("claude", "clawgod")) {
    $launcherContent | Set-Content (Join-Path $BinDir "$cmd.cmd") -Encoding Default
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
        Write-OK "Renamed claude.exe -> claude.orig.exe"
    } else {
        # Backup already exists -- just remove the new claude.exe
        try {
            Remove-Item -Force $claudeExe
        } catch {
            # Running binaries can often be renamed even when deletion fails.
            # A unique name also avoids collisions during repeated installs.
            $suffix = [Guid]::NewGuid().ToString('N')
            try {
                Rename-Item $claudeExe "claude.$suffix.exe" -ErrorAction Stop
            } catch {
                throw "Cannot remove or rename $claudeExe. Close Claude Code sessions (including VS Code), then rerun this installer. Use 'clawgod' to run the patched CLI in the meantime. Windows error: $($_.Exception.Message)"
            }
        }
    }
}
if (Test-Path $claudeExe) {
    throw "$claudeExe still shadows claude.cmd. Close Claude Code sessions and rerun this installer; use 'clawgod' in the meantime."
}
# An exe earlier in PATH can still shadow claude.cmd; clawgod is unambiguous.
Write-OK "Commands 'claude' + 'clawgod' -> patched"

# --- Ensure BinDir is in PATH -----------------------------------------

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
    $env:Path = "$BinDir;$env:Path"
    Write-OK "Added $BinDir to user PATH"
    Write-Dim "(restart terminal for PATH to take effect)"
}

# --- Done -------------------------------------------------------------

Write-Host ""
Write-Host "  ClawGod installed!" -ForegroundColor Green
Write-Host ""
Write-Dim "  claude            -- Start patched Claude Code (green logo)"
Write-Dim "  claude.orig       -- Run original unpatched Claude Code"
Write-Host ""
Write-Dim "  Updates: 'claude update' is patched to route through this installer."
Write-Dim "  Just run it as usual -- pulls latest Anthropic release + re-patches"
Write-Dim "  in one step. Extra options:"
Write-Dim "    claude update --version 2.1.180   (install a specific version)"
Write-Dim "    claude update --no-upgrade        (re-patch the installed version)"
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
Write-Dim "    scoop update bun               (scoop -- may lag stable)"
Write-Dim "    irm https://bun.sh/install.ps1 | iex   (re-install latest)"
Write-Host ""
