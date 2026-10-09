# Exercise the actual installer section with real Windows files and locks.
$ErrorActionPreference = 'Stop'
$template = Get-Content (Join-Path $PSScriptRoot '..\templates\install.ps1') -Raw
$section = [regex]::Match($template, '(?s)# Find and back up original claude.*?(?=# --- Ensure BinDir is in PATH)').Value
if (-not $section) { throw 'Installer launcher section not found' }
$install = [ScriptBlock]::Create($section)
$root = Join-Path ([IO.Path]::GetTempPath()) ('clawgod-launchers-' + [Guid]::NewGuid().ToString('N'))
$savedHome = $env:USERPROFILE
$savedLocal = $env:LOCALAPPDATA
$savedPath = $env:PATH
$node = (Get-Command node.exe).Source
$script:messages = New-Object 'System.Collections.Generic.List[string]'
function Write-OK($message) { $script:messages.Add($message) }
function Write-Warn($message) { $script:messages.Add($message) }
function Write-Dim($message) { $script:messages.Add($message) }
function Assert($condition, $message) { if (-not $condition) { throw $message } }

try {
    $env:USERPROFILE = $root
    $env:LOCALAPPDATA = Join-Path $root 'AppData\Local'
    $BinDir = Join-Path $root '.local\bin'
    New-Item -ItemType Directory -Force $BinDir | Out-Null
    $ClawDir = Join-Path $root '.clawgod'
    New-Item -ItemType Directory -Force $ClawDir | Out-Null
    $staged = Join-Path $ClawDir 'claude.staged.exe'
    $env:PATH = "$BinDir;$savedPath"
    $exe = Join-Path $BinDir 'claude.exe'
    $backup = Join-Path $BinDir 'claude.orig.exe'
    $cmd = Join-Path $BinDir 'claude.cmd'
    $launcherContent = '@echo clawgod-launcher-marker & rem %USERPROFILE%\.clawgod\cli.cjs'

    Copy-Item $node $exe
    $originalHash = (Get-FileHash $exe).Hash
    & $install
    Assert (-not (Test-Path $exe)) 'Fresh install left a competing exe'
    Assert ((Get-FileHash $backup).Hash -eq $originalHash) 'Native backup differs'

    # Repeated installs and repeated upstream repairs preserve the first backup.
    foreach ($attempt in 1..3) {
        & $install
        Assert (-not (Test-Path (Join-Path $BinDir 'claude.orig.cmd'))) 'Backed up our own launcher'
        Copy-Item $node $exe
        & $install
        Assert (-not (Test-Path $exe)) 'Reinstall left the repaired exe'
        Assert ((Get-FileHash $backup).Hash -eq $originalHash) 'Reinstall changed native backup'
        Assert ((Get-Command claude).Source -eq $cmd) 'PowerShell does not resolve claude.cmd'
        Assert ((& cmd.exe /d /c 'claude --version') -match 'clawgod-launcher-marker') 'cmd.exe bypassed launcher'
    }

    # An upgrade stages the binary it extracted from. The backup must follow
    # it, otherwise sessions spawned from execPath stay on the old version.
    # One trailing byte is enough to tell the "new" binary from the old one.
    function New-StagedNative {
        Copy-Item $node $staged -Force
        $stream = [IO.File]::Open($staged, [IO.FileMode]::Append)
        try { $stream.WriteByte(0) } finally { $stream.Dispose() }
        (Get-FileHash $staged).Hash
    }
    $upgradedHash = New-StagedNative
    Assert ($upgradedHash -ne $originalHash) 'Staged fixture does not differ from the backup'
    $script:messages.Clear()
    & $install
    Assert ((Get-FileHash $backup).Hash -eq $upgradedHash) 'Upgrade left the old native backup'
    Assert (-not (Test-Path $staged)) 'Staged native binary was not consumed'
    Assert ($script:messages -match 'Native binary refreshed') 'Refresh was not reported'

    # The daemon usually still runs the old backup during `claude update`.
    Copy-Item $node $backup -Force
    $upgradedHash = New-StagedNative
    $running = Start-Process $backup -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Milliseconds 300
        Assert (-not $running.HasExited) 'Running backup fixture did not start'
        $script:messages.Clear()
        & $install
        Assert ((Get-FileHash $backup).Hash -eq $upgradedHash) 'Running backup blocked the refresh'
        Assert (-not $running.HasExited) 'Refresh killed the running session'
        Assert ($script:messages -match 'until restarted') 'In-use backup was not mentioned'
    } finally {
        if (-not $running.HasExited) { Stop-Process -Id $running.Id -Force; $running.WaitForExit() }
        $running.Dispose()
    }
    # The renamed-aside copy is swept once nothing holds it, and a run with
    # nothing staged (-NoUpgrade) leaves the refreshed backup alone.
    & $install
    Assert (@(Get-ChildItem $BinDir -Filter 'claude.*.exe' | Where-Object Name -ne 'claude.orig.exe').Count -eq 0) 'Old backup was not swept'
    Assert ((Get-FileHash $backup).Hash -eq $upgradedHash) 'Install without a staged binary changed the backup'
    Copy-Item $node $backup -Force

    # A running Windows executable rejects deletion but normally allows rename.
    Copy-Item $node $exe
    $running = Start-Process $exe -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Milliseconds 300
        Assert (-not $running.HasExited) 'Executable lock fixture did not start'
        & $install
        Assert (-not (Test-Path $exe)) 'Running exe was not renamed aside'
        Assert (@(Get-ChildItem $BinDir -Filter 'claude.*.exe' | Where-Object Name -ne 'claude.orig.exe').Count -gt 0) 'Rename fallback was not exercised'
    } finally {
        if (-not $running.HasExited) { Stop-Process -Id $running.Id -Force; $running.WaitForExit() }
        $running.Dispose()
    }

    # A lock without delete sharing prevents both removal and rename. Never
    # report success, and still leave the explicit recovery launcher usable.
    Copy-Item $node $exe
    $lock = [IO.File]::Open($exe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $script:messages.Clear()
        $failure = $null
        try { & $install } catch { $failure = $_.Exception.Message }
        Assert ($failure -like '*Cannot remove or rename*') 'Locked exe did not report actionable failure'
        Assert (-not ($script:messages -match "Commands 'claude'")) 'Locked install reported success'
        Assert (Test-Path $exe) 'Lock fixture did not retain the executable'
        Assert ((& cmd.exe /d /c 'clawgod --version') -match 'clawgod-launcher-marker') 'Recovery alias is unavailable'
    } finally { $lock.Dispose() }
    & $install
    Assert (-not (Test-Path $exe)) 'Retry after releasing lock did not recover'

    # Our existing cmd must not stop discovery of a retained native version.
    Remove-Item $backup
    $versions = Join-Path $root '.local\share\claude\versions'
    New-Item -ItemType Directory -Force $versions | Out-Null
    Copy-Item $node (Join-Path $versions 'test-version')
    & $install
    Assert ((Get-FileHash $backup).Hash -eq $originalHash) 'Own launcher prevented native backup discovery'
    Assert (-not (Test-Path (Join-Path $BinDir 'claude.orig.cmd'))) 'Own launcher became original backup'

    # A genuine preexisting cmd remains eligible for backup.
    Set-Content $cmd '@echo original-launcher' -Encoding Ascii
    & $install
    Assert ((Get-Content (Join-Path $BinDir 'claude.orig.cmd') -Raw) -match 'original-launcher') 'Original cmd was not preserved'
    Write-Host '[launchers.test] repeated installs, native repair, upgrade refresh, running/locked exe, and backup preservation passed'
} finally {
    $env:USERPROFILE = $savedHome
    $env:LOCALAPPDATA = $savedLocal
    $env:PATH = $savedPath
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
