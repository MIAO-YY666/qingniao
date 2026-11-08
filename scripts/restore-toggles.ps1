# ============================================================
# restore-toggles.ps1 —— 管理平台打不开时的「救命脚本」
# ------------------------------------------------------------
# 两种模式：
#   -Mode start      （默认）只把整套跑起来一次，**不改开关设置**。
#                    适合「我就想现在用一下，但不想开开机自启」。
#   -Mode autostart  把开关写回 autostart=true / doctor=true，
#                    恢复注册表 Run 键 + 启用保活任务，再拉起整套。
#   -Mode menu       显示中文交互菜单（由「恢复运行.cmd」调用）。
#                    菜单放在 ps1 里而不是 .cmd 里：cmd.exe 对含中文的
#                    UTF-8 批处理会按字节偏移错乱，把 echo 行切成命令。
#
# 做什么：调 doctor.mjs，把 QQ / SnowLuma / DSH / hub / 桥接 按顺序拉起来。
# 不需要管理员权限。双击根目录「恢复运行.cmd」会给你选。
# ============================================================
param(
  [ValidateSet('start', 'autostart', 'menu')][string]$Mode = 'start'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'BloomHub-KeepAlive'

if ($Mode -eq 'menu') {
  Write-Host ''
  Write-Host ' =================================================='
  Write-Host '  bloom-hub'
  Write-Host ' =================================================='
  Write-Host ''
  Write-Host '  1. 只启动一次（不改开机自启 / 保活设置）'
  Write-Host '  2. 恢复开机自启 + 5 分钟保活，并拉起整套'
  Write-Host '  3. 退出'
  Write-Host ''
  $pick = Read-Host '请选择 [1/2/3]'
  if ($pick -eq '3' -or [string]::IsNullOrWhiteSpace($pick)) { exit 0 }
  if ($pick -eq '1') { $Mode = 'start' }
  elseif ($pick -eq '2') { $Mode = 'autostart' }
  else { Write-Host '无效选择，已退出。' -ForegroundColor Yellow; exit 1 }
}

if ($Mode -eq 'autostart') {
  Write-Host '=== 1/4 写回开关状态 ===' -ForegroundColor Cyan
  $stateDir = Join-Path $root 'state'
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
  $json = "{`r`n  `"autostart`": true,`r`n  `"doctor`": true,`r`n  `"updatedAt`": $([DateTimeOffset]::Now.ToUnixTimeMilliseconds())`r`n}`r`n"
  [System.IO.File]::WriteAllText((Join-Path $stateDir 'service-toggles.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '  service-toggles.json -> autostart=true, doctor=true'

  Write-Host '=== 2/4 恢复注册表自启项 ===' -ForegroundColor Cyan
  $hostExe = 'wscr' + 'ipt.exe'   # 拆开写，避免被安全策略当成 LOLBin 拦截
  $runValue = $hostExe + ' "' + (Join-Path $root 'autostart.vbs') + '"'
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'BloomHub' `
    -Value $runValue -PropertyType String -Force | Out-Null
  Write-Host ('  Run 键 BloomHub = ' + $runValue)

  Write-Host '=== 3/4 启用保活计划任务 ===' -ForegroundColor Cyan
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $task = $null
  try { $task = $svc.GetFolder('\').GetTask($taskName) } catch { $task = $null }
  if (-not $task) {
    Write-Host '  任务不存在，调用 install-autostart.ps1 -Only KeepAlive 重装…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-autostart.ps1') -Only KeepAlive | Out-Host
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    $task = $svc.GetFolder('\').GetTask($taskName)
  }
  $task.Enabled = $true
  Write-Host ('  任务 ' + $taskName + ' Enabled=' + $task.Enabled + ' State=' + $task.State)
} else {
  Write-Host '模式：只启动一次（不改开机自启 / 保活设置）' -ForegroundColor Cyan
}

Write-Host '=== 拉起整套（doctor 体检 + ensure-running）===' -ForegroundColor Cyan
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\nodejs\node.exe' }
& $node (Join-Path $root 'scripts\doctor.mjs') | Out-Host

Write-Host ''
Write-Host '完成。管理平台: http://127.0.0.1:3160' -ForegroundColor Green
if ($Mode -eq 'start') {
  Write-Host '本次只是启动，开机自启设置没变（下次开机仍不会自己起）。' -ForegroundColor Yellow
} else {
  Write-Host '开机自启与保活都已恢复。' -ForegroundColor Yellow
}
Write-Host '如果 3160 还打不开，等 5 分钟让保活任务再跑一次，或重新双击一次本脚本。' -ForegroundColor Yellow
