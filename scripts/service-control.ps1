# ============================================================
# service-control.ps1 —— start-all.bat / stop-all.bat 的实际逻辑
# ------------------------------------------------------------
# start : 写回 doctor 开关 → 启用/补装 BloomHub-KeepAlive → 立即触发
#         一次任务（由计划任务托管拉起整栈，避免交互式 shell 起的服务
#         被会话回收）→ 轮询 :3160 / :3100 直到就绪。
#         启动链路只有这一条：保活任务可能因撞 doctor.lock 而排队，等它
#         跑完即可；超时如实报错，绝不在交互式会话里再跑一遍
#         ensure-running --force（两条 --force 会绕过 10 分钟去抖锁并发抢起）。
# stop  : 先关 doctor 开关并禁用保活任务（否则 5 分钟内服务会被自动
#         拉回，且 doctor 会把被禁用的任务重新启用）→ 按 pid / lock
#         精确停 hub 与桥接 → 清理陈旧锁。
# 约定 : QQ 客户端 / SnowLuma / DSH 桌面端保持不动；autostart（注册表
#         Run 键）开关也保持原值，只动「5 分钟保活」这一项。
# ============================================================
param(
  [ValidateSet('start', 'stop', 'status', 'restart-bridge')][string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'BloomHub-KeepAlive'
$togglesFile = Join-Path $root 'state\service-toggles.json'
$installScript = Join-Path $root 'scripts\install-autostart.ps1'
$hubPidFile = Join-Path $root 'state\hub.pid'
$bridgeLockFile = Join-Path $root 'qq-bridge\state\bridge.lock'

function Read-Toggles {
  try {
    $j = Get-Content $togglesFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return @{ autostart = ($j.autostart -ne $false); doctor = ($j.doctor -ne $false) }
  } catch {
    return @{ autostart = $true; doctor = $true }
  }
}

function Write-DoctorToggle([bool]$on) {
  $t = Read-Toggles
  $obj = [ordered]@{
    autostart = [bool]$t.autostart
    doctor    = $on
    updatedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  }
  $json = ($obj | ConvertTo-Json) + "`r`n"
  New-Item -ItemType Directory -Force -Path (Split-Path $togglesFile) | Out-Null
  [System.IO.File]::WriteAllText($togglesFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('  service-toggles.json -> doctor=' + $on.ToString().ToLower() +
    '（autostart 保持 ' + ([bool]$t.autostart).ToString().ToLower() + '）')
}

function Get-KeepAliveTask {
  return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function Set-KeepAlive([bool]$on) {
  $t = Get-KeepAliveTask
  if (-not $t) {
    if (-not $on) {
      Write-Host '  保活任务不存在，无需禁用'
      return $true
    }
    Write-Host '  保活任务缺失，调用 install-autostart.ps1 -Only KeepAlive 补装…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installScript -Only KeepAlive | Out-Host
    $t = Get-KeepAliveTask
    if (-not $t) { throw '保活任务补装失败，请检查 scripts/install-autostart.ps1' }
  }
  if ($on) {
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  } else {
    Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  }
  $after = Get-KeepAliveTask
  $isEnabled = ($after.State -ne 'Disabled')
  Write-Host ('  计划任务 ' + $taskName + ' -> ' + $after.State)
  # 返回「是否达到目标状态」，而不是「当前是否启用」
  return ($isEnabled -eq $on)
}

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(700)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Get-ServiceState {
  $hub = Test-Port 3160
  $bridge = Test-Port 3100
  Write-Host ('  管理平台 :3160 = ' + $(if ($hub) { '在线' } else { '未运行' }) +
    '；QQ 桥接 :3100 = ' + $(if ($bridge) { '在线' } else { '未运行' }))
  return ($hub -and $bridge)
}

function Stop-ByPidFile([string]$file, [string]$label) {
  if (-not (Test-Path $file)) {
    Write-Host ('  ' + $label + '：无 pid 文件，跳过')
    return
  }
  $raw = (Get-Content $file -Raw -ErrorAction SilentlyContinue).Trim()
  if ($raw -match '^\d+$') {
    $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Write-Host ('  ' + $label + ' 已停止 (pid ' + $raw + ')')
    } else {
      Write-Host ('  ' + $label + '：pid ' + $raw + ' 已失效或非 node 进程，跳过')
    }
  } else {
    Write-Host ('  ' + $label + '：pid 文件内容异常，跳过')
  }
  Remove-Item $file -Force -ErrorAction SilentlyContinue
}

function Stop-GuardWindows {
  $windows = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*start-all.bat*' -or $_.CommandLine -like '*bloom-hub*qq-bridge*start.bat*' }
  $n = 0
  foreach ($w in $windows) {
    Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
    $n++
  }
  Write-Host ('  守护窗口已停止 ' + $n + ' 个')
}

# ------------------------------------------------------------
if ($Action -eq 'status') {
  $t = Read-Toggles
  $task = Get-KeepAliveTask
  Write-Host ('doctor 开关 = ' + $t.doctor + '；autostart 开关 = ' + $t.autostart)
  Write-Host ('保活任务 = ' + $(if ($task) { $task.State } else { '不存在' }))
  Get-ServiceState | Out-Null
  exit 0
}

# 调试桥接时只重启桥接：不动 hub、不动保活开关、不触发整栈 doctor 重检。
# 这样比「stop-all → start-all」少两轮全栈启停，DSH / QQ / SnowLuma 桌面端
# 全程不断，缓存失效面也小得多。启动仍走唯一的保活任务链路。
if ($Action -eq 'restart-bridge') {
  Write-Host '=== 仅重启 QQ 桥接（hub / 保活 / DSH 桌面端保持不动）==='
  $task = Get-KeepAliveTask
  if (-not $task -or $task.State -eq 'Disabled') {
    throw '保活任务未启用，无法托管重启桥接；请先执行 start-all.bat'
  }
  Write-Host '--- 1/3 停止桥接 ---'
  Stop-ByPidFile $bridgeLockFile 'bridge'
  Start-Sleep -Seconds 2
  Write-Host '--- 2/3 触发保活任务重新拉起 ---'
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Port 3100) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  Write-Host '--- 3/3 结果 ---'
  if ($ready) {
    Write-Host 'QQ 桥接已由保活任务重新拉起（:3100 在线）'
    exit 0
  }
  Write-Host '60 秒内桥接未就绪，请查看 logs/doctor.log 与 qq-bridge/state/bridge.log' -ForegroundColor Yellow
  exit 1
}

if ($Action -eq 'stop') {
  Write-Host '=== 停止 bloom-hub（管理平台 + QQ 桥接 + 5 分钟保活）==='

  Write-Host '--- 1/3 先关保活，避免服务被自动拉回 ---'
  Write-DoctorToggle $false
  $disabled = Set-KeepAlive $false
  if (-not $disabled) { Write-Host '  警告：保活任务未能成功禁用（可能被其他体检重新启用）' -ForegroundColor Yellow }

  Write-Host '--- 2/3 停止服务 ---'
  Stop-ByPidFile $hubPidFile 'hub'
  Stop-ByPidFile $bridgeLockFile 'bridge'
  Stop-GuardWindows

  Write-Host '--- 3/3 结果 ---'
  Get-ServiceState | Out-Null
  Write-Host '已停止（QQ / SnowLuma / DSH 桌面端保留；开机自启 Run 键未改动）'
  exit 0
}

# ---- start ----
Write-Host '=== 启动 bloom-hub（整栈 + 5 分钟保活）==='

Write-Host '--- 1/3 打开 doctor 开关并启用保活任务 ---'
Write-DoctorToggle $true
$enabled = Set-KeepAlive $true
if (-not $enabled) { throw '保活任务启用失败，整栈启动已中止' }

Write-Host '--- 2/3 立即触发一次保活任务（唯一的启动链路）---'
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Host '  已触发，等待 :3160 / :3100 就绪（最多 60 秒）…'

# 只等这一条链路：任务与 5 分钟周期体检撞 doctor.lock 时会排队，属正常，
# 等它跑完即可。不在交互式会话里补跑 ensure-running --force —— 两条 --force
# 会绕过 10 分钟去抖锁，并发重复拉起 QQ / DSH / 整栈，也把「任务托管」的意义抵消掉。
$timeoutSec = 60
$startAt = Get-Date
$deadline = $startAt.AddSeconds($timeoutSec)
$ready = $false
$nextReportAt = 15
while ((Get-Date) -lt $deadline) {
  if ((Test-Port 3160) -and (Test-Port 3100)) { $ready = $true; break }
  $elapsed = [int]((Get-Date) - $startAt).TotalSeconds
  if ($elapsed -ge $nextReportAt) {
    Write-Host ('  已等待 ' + $elapsed + ' 秒，保活任务仍在启动或排队…')
    $nextReportAt += 15
  }
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  $taskNow = Get-KeepAliveTask
  Write-Host ('  60 秒内未就绪。任务当前状态：' + $(if ($taskNow) { $taskNow.State } else { '不存在' })) -ForegroundColor Yellow
  Write-Host '  没有走第二条启动链路，避免与保活任务并发重复拉起。' -ForegroundColor Yellow
  Write-Host '  请查看 logs\doctor.log 与 logs\ensure-running.log；常见原因是任务撞 doctor.lock 排队或 QQ 未登录。' -ForegroundColor Yellow
  Write-Host '  可稍等片刻重新双击 start-all.bat，或运行 node scripts\doctor.mjs --json 看体检结果。' -ForegroundColor Yellow
  Get-ServiceState | Out-Null
  exit 1
}

Write-Host '--- 3/3 结果 ---'
$ok = Get-ServiceState
$task = Get-KeepAliveTask
$info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host ('  保活任务 ' + $taskName + ' -> ' + $(if ($task) { $task.State } else { '不存在' }) +
  '；下次运行 ' + $(if ($info) { $info.NextRunTime } else { '未知' }))
if ($ok) {
  Write-Host '完成。管理平台：http://127.0.0.1:3160（令牌在 config\suite.json 或 state\hub-token）' -ForegroundColor Green
  exit 0
} else {
  Write-Host '仍有组件未就绪，请手动查看 logs/doctor.log 与 logs/ensure-running.log' -ForegroundColor Yellow
  exit 1
}
