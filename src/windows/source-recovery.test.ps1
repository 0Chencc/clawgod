$ErrorActionPreference = 'Stop'
$template = Get-Content (Join-Path $PSScriptRoot '..\templates\install.ps1') -Raw
$section = [regex]::Match($template, '(?s)# --- Handle -NoUpgrade.*?(?=if \(-not \$NoUpgrade\) \{)').Value
if (-not $section) { throw 'Source recovery section not found' }
$selectSource = [ScriptBlock]::Create($section)
$ClawDir = Join-Path ([IO.Path]::GetTempPath()) ('clawgod-source-recovery-' + [Guid]::NewGuid().ToString('N'))
$BinDir = Join-Path $ClawDir 'bin'
function Write-OK($message) {}
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
    Write-Host '[source-recovery.test] exact-version migration and local backup selection passed'
} finally { Remove-Item -Recurse -Force $ClawDir }
