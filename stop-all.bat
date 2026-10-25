@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 停止 bloom-hub 管理平台与 QQ 桥接（SnowLuma 网关与 QQ 客户端保留运行）…

rem 1) 管理平台 hub（按 PID 文件精确停止）
powershell -NoProfile -Command "$pf='state\hub.pid'; if (Test-Path $pf) { $p = Get-Content $pf -ErrorAction SilentlyContinue; if ($p -match '^\d+$') { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ("hub 已停止 (pid " + $p + ")") }; Remove-Item $pf -Force -ErrorAction SilentlyContinue }"

rem 2) QQ 桥接（bridge.lock 里是桥接进程 PID；守护窗口一并停掉）
powershell -NoProfile -Command "$lf='qq-bridge\state\bridge.lock'; if (Test-Path $lf) { $p = Get-Content $lf -ErrorAction SilentlyContinue; if ($p -match '^\d+$') { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ("bridge 已停止 (pid " + $p + ")") } }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start-all.bat*' -or $_.CommandLine -like '*bloom-hub*qq-bridge*start.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem 3) 清理陈旧锁
del /q "qq-bridge\state\bridge.lock" 2>nul
echo 已停止。
