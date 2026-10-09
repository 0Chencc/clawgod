$ErrorActionPreference = 'Stop'
$template = Get-Content (Join-Path $PSScriptRoot '..\templates\install.ps1') -Raw
$section = [regex]::Match($template, '(?s)# --- Handle -NoUpgrade.*?(?=if \(-not \$NoUpgrade\) \{)').Value
if (-not $section) { throw 'Source recovery section not found' }
$selectSource = [ScriptBlock]::Create($section)
$ClawDir = Join-Path ([IO.Path]::GetTempPath()) ('clawgod-source-recovery-' + [Guid]::NewGuid().ToString('N'))
$BinDir = Join-Path $ClawDir 'bin'
function Write-OK($message) {}
function Write-Dim($message) {}
function Write-Err($message) {}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
    New-Item -ItemType Directory -Force $ClawDir | Out-Null
    Set-Content (Join-Path $ClawDir 'cli.original.cjs') '// Version: 2.1.272'
    Set-Content (Join-Path $ClawDir '.source-version') '2.1.283'
    $NoUpgrade = [switch]$true; $Version = 'latest'
    . $selectSource
    Assert (-not $NoUpgrade -and $Version -eq '2.1.283') 'Recovery did not use stamped installed version'
    Remove-Item (Join-Path $ClawDir '.source-version')
    $NoUpgrade = [switch]$true; $Version = 'latest'
    . $selectSource
    Assert (-not $NoUpgrade -and $Version -eq '2.1.272') 'Entry version fallback failed'
    Set-Content (Join-Path $ClawDir 'source-backup.json') '{}'
    $NoUpgrade = [switch]$true; $Version = 'latest'
    . $selectSource
    Assert ($NoUpgrade -and $Version -eq 'latest') 'Complete backup should avoid downloads'
    Remove-Item (Join-Path $ClawDir 'source-backup.json')
    Set-Content (Join-Path $ClawDir 'cli.original.cjs') '// unknown version'
    $NoUpgrade = [switch]$true; $Version = 'latest'
    $failed = $false
    try { . $selectSource } catch { $failed = $true }
    Assert $failed 'Unknown installed version must not upgrade to latest'

    $rollbackSection = [regex]::Match($template, '(?s)# --- Snapshot existing installation.*?(?=# Always write the extractor)').Value
    Assert $rollbackSection 'Rollback section not found'
    $snapshot = [ScriptBlock]::Create($rollbackSection)
    Set-Content (Join-Path $ClawDir 'cli.original.cjs') '// old source'
    Set-Content (Join-Path $ClawDir '.source-version') '2.1.280'
    Set-Content (Join-Path $ClawDir 'cli.cjs') '// old wrapper'
    New-Item -ItemType Directory -Path (Join-Path $ClawDir 'bunfs') | Out-Null
    Set-Content (Join-Path $ClawDir 'bunfs\commands.js') '// old graph'
    . $snapshot
    Remove-Item -Recurse -Force (Join-Path $ClawDir 'bunfs')
    Set-Content (Join-Path $ClawDir 'cli.original.cjs') '// new source'
    Set-Content (Join-Path $ClawDir '.source-version') '2.1.299'
    Set-Content (Join-Path $ClawDir 'cli.cjs') '// new wrapper'
    Set-Content (Join-Path $ClawDir 'claude.staged.exe') 'new binary'
    Restore-Install
    Assert (((Get-Content (Join-Path $ClawDir 'cli.original.cjs') -Raw).Trim()) -eq '// old source') 'Source rollback failed'
    Assert (((Get-Content (Join-Path $ClawDir '.source-version') -Raw).Trim()) -eq '2.1.280') 'Version rollback failed'
    Assert (((Get-Content (Join-Path $ClawDir 'cli.cjs') -Raw).Trim()) -eq '// old wrapper') 'Wrapper rollback failed'
    Assert (((Get-Content (Join-Path $ClawDir 'bunfs\commands.js') -Raw).Trim()) -eq '// old graph') 'Graph rollback failed'
    Assert (-not (Test-Path (Join-Path $ClawDir 'claude.staged.exe'))) 'Staged binary was not cleaned up'
    $staleCleanup = [regex]::Match($template, '(?s)# A failed earlier upgrade may have left a newer native binary staged\..*?(?=# --- Write re-patch helper)').Value
    Assert $staleCleanup 'Stale native cleanup section not found'
    Set-Content (Join-Path $ClawDir 'claude.staged.exe') 'stale newer binary'
    $NoUpgrade = [switch]$true
    . ([ScriptBlock]::Create($staleCleanup))
    Assert (-not (Test-Path (Join-Path $ClawDir 'claude.staged.exe'))) '-NoUpgrade retained a stale staged binary'
    Write-Host '[source-recovery.test] exact-version migration and failure rollback passed'
} finally { Remove-Item -Recurse -Force $ClawDir }
