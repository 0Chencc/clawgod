# Run the actual installer probe under Windows PowerShell 5.1, including its
# native stderr/ErrorActionPreference behavior and abort-before-launcher path.
$ErrorActionPreference = 'Stop'
$template = Get-Content (Join-Path $PSScriptRoot '..\templates\install.ps1') -Raw
$section = [regex]::Match($template, '(?s)Write-Dim "Verifying Bun.*?(?=# --- Replace claude command)').Value
if (-not $section) { throw 'Startup verification section not found' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('clawgod startup-' + [Guid]::NewGuid().ToString('N'))
$scriptPath = Join-Path $root 'check.ps1'
$savedDir = $env:CLAWGOD_TEST_DIR
$savedTimeout = $env:CLAWGOD_STARTUP_TIMEOUT_MS
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
    New-Item -ItemType Directory -Force $root | Out-Null
    Copy-Item (Join-Path $PSScriptRoot '..\shared\startup-check.cjs') (Join-Path $root 'startup-check.cjs')
    $env:CLAWGOD_TEST_DIR = $root
    $env:CLAWGOD_STARTUP_TIMEOUT_MS = '1200'
    $prefix = @'
$ErrorActionPreference = 'Stop'
$ClawDir = $env:CLAWGOD_TEST_DIR
$BunBin = (Get-Command node.exe).Source
function Write-Dim($message) { Write-Host $message }
function Write-Err($message) { Write-Host $message }
function Write-OK($message) { Write-Host $message }
function Restore-Install {}
'@
    $suffix = @'
if ($ErrorActionPreference -ne 'Stop') { throw 'ErrorActionPreference was not restored' }
Write-Host 'launcher-step-reached'
'@
    Set-Content $scriptPath ($prefix + "`r`n" + $section + "`r`n" + $suffix) -Encoding ASCII
    $cases = @(
        @{ Code = 'console.log("2.1.285 (Claude Code)");'; Exit = 0; Expected = 'Bun loads cli.original.cjs' },
        @{ Code = 'console.error("fixture stderr"); console.log("2.1.285 (Claude Code)");'; Exit = 0; Expected = 'Bun loads cli.original.cjs' },
        @{ Code = 'console.error("fixture startup failed"); process.exit(7);'; Exit = 7; Expected = 'fixture startup failed' },
        @{ Code = 'console.log("2.1.285 (Claude Code)"); setInterval(()=>{},1000);'; Exit = 124; Expected = 'timed out after 1200 ms' },
        @{ Code = 'console.error("Expected CommonJS module to have a function wrapper"); process.exit(1);'; Exit = 1; Expected = 'bun upgrade --canary' },
        @{ Code = ''; Exit = 1; Expected = 'did not print a Claude Code version' }
    )
    foreach ($case in $cases) {
        Set-Content (Join-Path $root 'cli.cjs') $case.Code -Encoding ASCII
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath 2>&1 | Out-String
            $code = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previous }
        Assert ($code -eq $case.Exit) "Expected exit $($case.Exit), got ${code}: $output"
        Assert ($output.Contains($case.Expected)) "Missing diagnostic: $output"
        Assert ($output.Contains('launcher-step-reached') -eq ($case.Exit -eq 0)) "Failed check reached launcher replacement: $output"
        Assert (Test-Path (Join-Path $root 'startup-check.log')) 'Missing startup log'
    }
    Write-Host '[startup-check.test] Windows installer startup success, stderr, failure, timeout and Bun diagnostic passed'
} finally {
    $env:CLAWGOD_TEST_DIR = $savedDir
    $env:CLAWGOD_STARTUP_TIMEOUT_MS = $savedTimeout
    Remove-Item -Recurse -Force $root
}
# Expected-failure probes leave LASTEXITCODE nonzero. Actions' PowerShell
# wrapper propagates it even after all assertions pass, so report suite success.
exit 0
