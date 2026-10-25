# Start qq-bridge as a standalone process (independent of any agent session).
#
# Invoked by the Windows scheduled task "qq-bridge" at logon, or run manually.
#
# IMPORTANT: keep this file ASCII-only.
# Windows PowerShell 5.1 (what Task Scheduler launches) does not treat a
# BOM-less file as UTF-8, so non-ASCII comments get mis-decoded into mojibake,
# which previously consumed the closing quote on the node invocation below and
# made the whole script fail to parse (task exited 1, log empty).
#
# Why D:\dshbin must be on PATH: `dsh plugin` installs profile bundles with
# pnpm, and D:\dshbin\pnpm.exe is the shim provided for that (see README).
#
# Log redirection must use `*>>` (all streams). Windows PowerShell 5.1 does not
# support `1>>` / `2>>` on a native command invocation here.

$ErrorActionPreference = 'Continue'

$repo = 'D:\harnessWorkspace\qq-bridge'
$logDir = Join-Path $repo 'state'
$log = Join-Path $logDir 'bridge-daemon.log'
$node = 'D:\nodejs\node.exe'
$entry = Join-Path $repo 'src\bridge.js'

function Write-DaemonLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# Duplicate guard: the bridge has its own single-instance lock, but check the
# console port first so repeated task runs do not spam the log.
# Get-NetTCPConnection is unreliable on this host (reported no listener while
# netstat clearly showed one), so parse netstat instead.
$listening = & netstat.exe -ano | Select-String 'LISTENING' | Select-String ':3100\s'
if ($listening) {
  Write-DaemonLog 'bridge already running (port 3100 busy), skip start'
  exit 0
}

$env:PATH = 'D:\dshbin;' + $env:PATH
Set-Location $repo

Write-DaemonLog 'starting qq-bridge (console http://127.0.0.1:3100)'

# Run in the foreground: Task Scheduler owns the lifetime (execution time limit
# is set to unlimited), so the task stays alive as long as the bridge runs.
& $node $entry *>> $log
$code = $LASTEXITCODE
Write-DaemonLog ("qq-bridge exited, code={0}" -f $code)
exit $code
