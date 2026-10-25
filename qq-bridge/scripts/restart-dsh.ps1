# Restart DSH (dsh web), detaching from the DSH process tree.
#
# *** DEPRECATED / DISABLED (2026-10-24) ***
# 桥接已不再连接独立 `dsh web`：bloom-hub 的 dsh-link 服务监听固定端口 3080，
# 自动转发到 DeepSeek Harness 桌面客户端的内嵌 web（动态端口）。
# 本脚本会杀掉 3080 的监听进程 —— 那现在是我们自己的转发层 —— 并重新下载
# 已删除的 npx 缓存，所以已直接禁用。
# DSH 没起来时请：启动 DeepSeek Harness 桌面客户端（或双击 bloom-hub\start-all.bat），
# dsh-link 会自动发现它；保活任务 BloomHub-KeepAlive 也会自动拉起。
#
# v2: the v1 probe used Get-NetTCPConnection, which is unreliable on this host
# (it reported no listener while netstat clearly showed one), so v1 relaunched a
# second DSH that exited immediately on the busy port and never restarted
# anything. This version reads the listener PID from netstat.
#
# Launched process (captured from the live process tree):
#   node D:\npm-global\node_modules\npm\bin\npx-cli.js @deepseek-ai/dsh web

$ErrorActionPreference = 'Continue'
Write-Host '此脚本已停用：桥接现在经 bloom-hub 的 dsh-link(:3080) 连接 DeepSeek Harness 桌面客户端。'
Write-Host '若 DSH 未运行，直接启动桌面客户端即可（或双击 bloom-hub\start-all.bat）。'
exit 0
$logDir = 'D:\harnessWorkspace\qq-bridge\state'
$log = Join-Path $logDir 'dsh-restart.log'

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Get-Port3080Pid {
  $line = (& netstat.exe -ano | Select-String 'LISTENING' | Select-String ':3080\s') | Select-Object -First 1
  if (-not $line) { return $null }
  $parts = ($line.ToString().Trim() -split '\s+')
  return $parts[-1]
}

Write-Log '=== restart requested (v2) ==='

$dshPid = Get-Port3080Pid
Write-Log ("DSH pid owning :3080 = {0}" -f ($(if ($dshPid) { $dshPid } else { 'none' })))

if (-not $dshPid) {
  Write-Log 'nothing listening on :3080; will just start a new instance'
} else {
  & taskkill.exe /PID $dshPid /T /F 2>&1 | ForEach-Object { Write-Log ("taskkill: {0}" -f $_) }
}

# wait for the listener to disappear
$gone = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-Port3080Pid)) { $gone = $true; break }
}
Write-Log ("old listener gone = {0}" -f $gone)
Start-Sleep -Seconds 3

# relaunch exactly as before
$npx = 'D:\npm-global\node_modules\npm\bin\npx-cli.js'
$out = Join-Path $logDir 'dsh-restart.out.log'
$err = Join-Path $logDir 'dsh-restart.err.log'
try {
  $proc = Start-Process -FilePath 'D:\nodejs\node.exe' `
    -ArgumentList @($npx, '@deepseek-ai/dsh', 'web') `
    -WorkingDirectory 'D:\harnessWorkspace' `
    -RedirectStandardOutput $out -RedirectStandardError $err `
    -WindowStyle Hidden -PassThru
  Write-Log ("relaunched DSH, npx pid = {0}" -f $proc.Id)
} catch {
  Write-Log ("relaunch threw: {0}" -f $_.Exception.Message)
  exit 1
}

# wait for the listener to come back
$newPid = $null
for ($i = 0; $i -lt 150; $i++) {
  Start-Sleep -Seconds 1
  $newPid = Get-Port3080Pid
  if ($newPid) { break }
}
Write-Log ("DSH listening again = {0} (pid {1})" -f ([bool]$newPid), $newPid)

if ($newPid) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 10
    Write-Log ("probe HTTP {0}" -f $r.StatusCode)
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
    Write-Log ("probe = {0} (401 expected: browser auth)" -f ($(if ($code) { $code } else { $_.Exception.Message })))
  }
  Write-Log ("stdout tail: {0}" -f (((Get-Content $out -Tail 10 -ErrorAction SilentlyContinue) -join ' | ')))
  if (Test-Path $err) {
    Write-Log ("stderr tail: {0}" -f (((Get-Content $err -Tail 10 -ErrorAction SilentlyContinue) -join ' | ')))
  }
} else {
  Write-Log ("FAILED to rebind; stdout: {0}" -f (((Get-Content $out -Tail 15 -ErrorAction SilentlyContinue) -join ' | ')))
  Write-Log ("FAILED to rebind; stderr: {0}" -f (((Get-Content $err -Tail 15 -ErrorAction SilentlyContinue) -join ' | ')))
}

# 5. 把桥接拉回来。
# 杀掉 DSH 会连坐清理它的整个进程树，而桥接之前是作为 agent 的后台作业跑在
# 那棵树里的，所以必须重新拉起。走计划任务启动，进程挂在任务计划服务下，
# 后续不再受 DSH / agent 会话生死影响。
Write-Log '--- restarting qq-bridge via scheduled task ---'
& schtasks.exe /Run /TN qq-bridge 2>&1 | ForEach-Object { Write-Log ("schtasks: {0}" -f $_) }

$bridgeUp = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $listen = & netstat.exe -ano | Select-String 'LISTENING' | Select-String ':3100\s'
  if ($listen) { $bridgeUp = $true; break }
}
Write-Log ("qq-bridge listening on 3100 = {0}" -f $bridgeUp)

Write-Log '=== restart helper done (v2) ==='
