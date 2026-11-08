param(
  # Both=两个都装（默认）；Run=只装注册表自启；KeepAlive=只装保活计划任务
  [ValidateSet('Both','Run','KeepAlive')][string]$Only = 'Both'
)
$ErrorActionPreference = 'Stop'
# ============================================================
# install-autostart.ps1 —— bloom-hub 开机自启 + 保活（幂等，无需管理员）
#   1) HKCU Run 键 BloomHub        → 登录时隐藏运行 doctor.mjs（内含整栈拉起）
#   2) 计划任务 BloomHub-KeepAlive → 每 5 分钟跑一次 doctor.mjs（崩溃自愈）
#
# 实现说明（都是踩过的坑）：
#   · 开始菜单「启动」文件夹在这台机器上被脚本拦截 → 用注册表 Run 键。
#   · 「登录时启动」触发器（LogonTrigger）在非管理员下注册会 Access denied，
#     而 Run 键本来就覆盖登录场景，所以任务只配 5 分钟定时。
#   · schtasks /create 可用，但默认「电池上不启动」；用 XML 导出→改设置→导入
#     的方式把它关掉，并打开「错过后补跑」（StartWhenAvailable）。
# ============================================================
$root = Split-Path -Parent $PSScriptRoot   # 本脚本在 scripts\，父目录即项目根（随项目位置走）
$taskName = 'BloomHub-KeepAlive'
$runCmd = 'wscript.exe "' + $root + '\autostart.vbs"'
$taskCmd = 'wscript.exe "' + $root + '\scripts\doctor-hidden.vbs"'
$xmlPath = Join-Path $root 'state\task-definition.xml'

# ---- 1) 注册表 Run 键（登录即拉起，不闪窗） ----
if ($Only -ne 'KeepAlive') {
  reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v BloomHub /t REG_SZ /d $runCmd /f | Out-Host
}

# ---- 2) 计划任务 ----
if ($Only -ne 'Run') {
New-Item -ItemType Directory -Force -Path (Split-Path $xmlPath) | Out-Null
& schtasks /create /tn $taskName /sc minute /mo 5 /tr $taskCmd /f 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'schtasks /create 失败' }

& schtasks /query /tn $taskName /xml ONE > $xmlPath 2>&1
if ($LASTEXITCODE -ne 0) { throw 'schtasks /query /xml 失败' }

$raw = Get-Content $xmlPath -Raw -Encoding Unicode
# 电池 / 错过补跑 / 执行上限：强制成期望值（元素缺失就补上）
if ($raw -match '<DisallowStartIfOnBatteries>') {
  $raw = $raw -replace '<DisallowStartIfOnBatteries>[^<]*</DisallowStartIfOnBatteries>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
} else {
  $raw = $raw -replace '(<Settings>)', "`$1`r`n    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
}
if ($raw -match '<StopIfGoingOnBatteries>') {
  $raw = $raw -replace '<StopIfGoingOnBatteries>[^<]*</StopIfGoingOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
} else {
  $raw = $raw -replace '(<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>)', "`$1`r`n    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"
}
if ($raw -match '<StartWhenAvailable>') {
  $raw = $raw -replace '<StartWhenAvailable>[^<]*</StartWhenAvailable>', '<StartWhenAvailable>true</StartWhenAvailable>'
} else {
  $raw = $raw -replace '(<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>)', "`$1`r`n    <StartWhenAvailable>true</StartWhenAvailable>"
}
if ($raw -match '<ExecutionTimeLimit>') {
  $raw = $raw -replace '<ExecutionTimeLimit>[^<]*</ExecutionTimeLimit>', '<ExecutionTimeLimit>PT15M</ExecutionTimeLimit>'
} else {
  $raw = $raw -replace '(<StartWhenAvailable>true</StartWhenAvailable>)', "`$1`r`n    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>"
}
$raw = $raw -replace '<LogonTrigger>[\s\S]*?</LogonTrigger>', ''   # 非管理员下会 Access denied
[System.IO.File]::WriteAllText($xmlPath, $raw, (New-Object System.Text.UnicodeEncoding($false, $true)))

& schtasks /delete /tn $taskName /f 2>&1 | Out-Null
& schtasks /create /tn $taskName /xml $xmlPath /f 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'schtasks /create /xml 失败（任务定义被拒）' }
}

# ---- 3) 验证并打印 ----
Write-Host ('--- 验证（只处理 ' + $Only + '）---')
if ($Only -ne 'KeepAlive') {
  reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v BloomHub | Out-Host
}
if ($Only -ne 'Run') {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { throw '计划的保活任务不存在' }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host ('任务状态：' + $task.State + '；上次运行：' + $info.LastRunTime + '；下次运行：' + $info.NextRunTime)
  Write-Host ('电池上仍运行：' + (-not $task.Settings.DisallowStartIfOnBatteries) + '；错过后补跑：' + $task.Settings.StartWhenAvailable + '；执行上限：' + $task.Settings.ExecutionTimeLimit)
}
Write-Host 'install done.'
